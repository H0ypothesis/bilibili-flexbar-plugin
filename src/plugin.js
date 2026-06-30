/**
 * Bilibili Plugin for FlexDesigner — 自包含版（无需独立 bridge 进程）
 * ============================================================================
 * 插件后端（FlexDesigner 的 Node 子进程）直接通过 Chrome DevTools 协议(CDP)
 * 驱动哔哩哔哩 Electron 客户端 player.html 里的 <video>：读取播放状态、下发控制。
 * 不修改 FlexDesigner 任何东西——这只是后端 Node 进程在用 child_process / ws 做事。
 *
 * 按键：
 *   nowplaying  正在播放（封面/标题/UP/进度，Canvas 绘制）
 *   progress    进度条滑块（拖拽 = 跳转）        ← slider
 *   playpause   播放 / 暂停                      ← multiState
 *   next        下一集（下一P）
 *   back/forward 快退 / 快进 15 秒
 *   seekwheel   旋钮微调进度                      ← wheel
 *   volumewheel 旋钮调节视频音量                  ← wheel
 *   danmaku     弹幕显示 / 隐藏                   ← multiState
 *   like/coin/favorite  点赞 / 投币 / 收藏        ← multiState
 */

const { plugin, logger } = require("@eniac/flexdesigner");
const CanvasRenderer = require('./canvas-renderer');
const { CDPClient } = require('./cdp');
const { STATE_EXPR, cmdExpr, bvidFromHref, fetchVideoMeta } = require('./bilibili');
const { exec, spawn } = require('child_process');

// ============================================================================
// 常量 / 配置
// ============================================================================

const UUID = 'com.h0ypothesis.bilibili';
const CID = {
    nowplaying: `${UUID}.nowplaying`,
    progress: `${UUID}.progress`,
    playpause: `${UUID}.playpause`,
    next: `${UUID}.next`,
    back: `${UUID}.back`,
    forward: `${UUID}.forward`,
    seekwheel: `${UUID}.seekwheel`,
    volumewheel: `${UUID}.volumewheel`,
    danmaku: `${UUID}.danmaku`,
    like: `${UUID}.like`,
    coin: `${UUID}.coin`,
    favorite: `${UUID}.favorite`,
};

const CDP_HOST = process.env.BILIBILI_CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.BILIBILI_CDP_PORT || '9222', 10);
const APP_NAME = process.env.BILIBILI_APP || '哔哩哔哩';
const POLL_MS = parseInt(process.env.BILIBILI_POLL_MS || '300', 10);
const AUTOLAUNCH = process.env.BILIBILI_NO_AUTOLAUNCH ? false : true;

const SKIP_SECONDS = 15;            // 快进/快退步长
const WHEEL_STEP_SEC = 2;           // 进度旋钮每格秒数
const VOL_STEP = 0.02;              // 音量旋钮灵敏度：每单位 delta 改变的音量（越小越不灵敏）
const SLIDER_HOLD_MS = 1200;        // 拖动后暂停回写滑块，避免与用户抢

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 状态
// ============================================================================

const cdp = new CDPClient({ host: CDP_HOST, port: CDP_PORT, urlMatch: 'player.html', log: (...a) => logger.info('[CDP]', ...a), debug: () => {} });

// 给按键用的派生状态
let currentState = {
    video: null,                    // { title, up, coverBase64 }
    playState: 'Stopped',
    timeline: { currentTime: 0, totalTime: 0 },
    social: { liked: false, coined: false, collected: false, likeCount: '' },
    extras: { volume: 1, muted: false, danmaku: null },
};

// 从页面读到的原始状态 + 元数据 + 进度插值基准
let live = { hasVideo: false, t: 0, dur: 0, paused: true, rate: 1, href: '', docTitle: '', up: null, social: null, vol: 1, muted: false, danmaku: null };
let meta = null, currentBvid = null, metaToken = 0;
let baseT = 0, baseAt = Date.now();
let cdpReady = false;

const deviceKeys = new Map();       // serialNumber -> { keys: Map<uid,key> }
const canvasRenderer = new CanvasRenderer(logger);

let sliderHoldUntil = 0;
let wheelAccum = 0, wheelFlushTimer = null;
let volAccum = 0, volFlushTimer = null;
let pollTimer = null, engineStarted = false, ensuring = false, restarting = false;

// ============================================================================
// 派生：原始 → 按键状态
// ============================================================================

function deriveVideo() {
    const title = (meta && meta.title) || live.docTitle || '';
    if (!live.hasVideo && !title) return null;
    return { title, up: (meta && meta.up) || live.up || '', coverBase64: (meta && meta.coverBase64) || null };
}
function derivePlayState() {
    if (!live.hasVideo) return 'Stopped';
    return live.paused ? 'Paused' : 'Playing';
}
function deriveSocial() {
    const s = live.social || {};
    return { liked: !!(s.like && s.like.on), coined: !!(s.coin && s.coin.on), collected: !!(s.fav && s.fav.on), likeCount: (s.like && s.like.n) || '' };
}
function deriveExtras() {
    return { volume: typeof live.vol === 'number' ? live.vol : 1, muted: !!live.muted, danmaku: (live.danmaku == null) ? null : !!live.danmaku };
}
function interpolatedSec() {
    let pos = baseT;
    if (live.hasVideo && !live.paused && live.rate) pos += ((Date.now() - baseAt) / 1000) * live.rate;
    const dur = live.dur || (meta && meta.durationSec) || 0;
    if (dur > 0) pos = Math.min(pos, dur);
    if (pos < 0) pos = 0;
    return { pos, dur };
}
function deriveTimeline() {
    const { pos, dur } = interpolatedSec();
    return { currentTime: Math.round(pos * 1000), totalTime: Math.round(dur * 1000) };
}

// ============================================================================
// 轮询 CDP → 更新按键
// ============================================================================

let lastVideoKey, lastPlayState, lastSocialKey, lastExtrasKey;

function applyState() {
    currentState.video = deriveVideo();
    currentState.playState = derivePlayState();
    currentState.social = deriveSocial();
    currentState.extras = deriveExtras();
    currentState.timeline = deriveTimeline();

    const vKey = JSON.stringify(currentState.video);
    if (vKey !== lastVideoKey) { lastVideoKey = vKey; updateAllKeys(); }            // 换视频/信息变化 → 全刷
    if (currentState.playState !== lastPlayState) { lastPlayState = currentState.playState; updatePlaybackKeys(); }
    const sKey = JSON.stringify(currentState.social);
    if (sKey !== lastSocialKey) { lastSocialKey = sKey; updateSocialKeys(); }
    const eKey = JSON.stringify(currentState.extras);
    if (eKey !== lastExtrasKey) { lastExtrasKey = eKey; updateExtrasKeys(); }
    updateTimelineKeys();                                                            // 每次轮询刷进度
}

async function onSnapshot(s) {
    if (!s || s.error) return;
    if (!s.hasVideo) {
        live = { hasVideo: false, t: 0, dur: 0, paused: true, rate: 1, href: s.href || '', docTitle: '', up: null, social: null, vol: 1, muted: false, danmaku: null };
        currentBvid = null; meta = null; baseT = 0; baseAt = Date.now();
        applyState();
        return;
    }
    live = {
        hasVideo: true,
        t: Number(s.t) || 0, dur: Number(s.dur) || 0, paused: !!s.paused, rate: Number(s.rate) || 1,
        href: s.href || '', docTitle: s.docTitle || '', up: s.up || null, social: s.social || null,
        vol: typeof s.vol === 'number' ? s.vol : 1, muted: !!s.muted, danmaku: (s.danmaku == null) ? null : !!s.danmaku,
    };
    baseT = live.t; baseAt = Date.now();

    const bvid = bvidFromHref(live.href);
    if (bvid && bvid !== currentBvid) {
        currentBvid = bvid; meta = null;
        const token = ++metaToken;
        fetchVideoMeta(bvid)
            .then((m) => { if (token === metaToken) { meta = m; logger.info(`[Plugin] 元数据: ${m.title} — ${m.up}`); applyState(); } })
            .catch(() => {});
    } else if (!bvid && currentBvid) { currentBvid = null; meta = null; }

    applyState();
}

async function pollLoop() {
    if (restarting) { pollTimer = setTimeout(pollLoop, POLL_MS); return; }   // 重启 B 站期间暂停，别用 CDP 打扰它退出/启动
    try {
        const snap = await cdp.evaluate(STATE_EXPR);
        if (!cdpReady) { cdpReady = true; logger.info('[Plugin] 已连接哔哩哔哩播放器 (CDP)'); }
        await onSnapshot(snap);
    } catch (e) {
        if (cdpReady) { cdpReady = false; logger.warn('[Plugin] 与哔哩哔哩连接断开: ' + e.message); }
        if (live.hasVideo) { live.hasVideo = false; applyState(); }
        if (!restarting) await ensureReachable(false);
    } finally {
        pollTimer = setTimeout(pollLoop, POLL_MS);
    }
}

// ============================================================================
// 哔哩哔哩 App 启动管理
// ============================================================================

// ★ 根因修复：FlexDesigner 是 Electron，它以 ELECTRON_RUN_AS_NODE=1 运行插件后端(.cjs)。该变量会被
// 我们 spawn/exec 的 open 继承，再传给同为 Electron 的哔哩哔哩 → B 站以「纯 Node 模式」启动、不开窗口
// 直接退出（表现为「跳一下就没了」）。所以拉起 B 站前必须剥离 ELECTRON_*/NODE_OPTIONS 等变量。
function cleanLaunchEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
        if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') delete env[k];
    }
    return env;
}

function launchApp() {
    try {
        const p = spawn('open', ['-a', APP_NAME, '--args', `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore', detached: true, env: cleanLaunchEnv() });
        p.on('error', (e) => logger.error('[Plugin] 启动哔哩哔哩失败: ' + e.message));
        p.unref();
    } catch (e) { logger.error('[Plugin] 启动哔哩哔哩异常: ' + e.message); }
}

async function ensureReachable(tryLaunch) {
    if (ensuring) return false;
    ensuring = true;
    try {
        if (await cdp.isReachable()) return true;
        if (tryLaunch && AUTOLAUNCH) { logger.info('[Plugin] 哔哩哔哩调试端口不可达，尝试启动…'); launchApp(); }
        for (let i = 0; i < 20; i++) { await delay(500); if (await cdp.isReachable()) return true; }
        return false;
    } finally { ensuring = false; }
}

function startEngine() {
    if (engineStarted) return;
    engineStarted = true;
    ensureReachable(true).finally(() => pollLoop());
}

// 命令：直接在页面里执行表达式
function cdpCmd(kind, arg) {
    return cdp.evaluate(cmdExpr(kind, arg)).catch((e) => { logger.error(`[Plugin] 命令 ${kind} 失败: ${e.message}`); return undefined; });
}

// ============================================================================
// 按键更新
// ============================================================================

function forEachKey(cb) {
    for (const [serialNumber, deviceData] of deviceKeys) {
        for (const [, key] of deviceData.keys) cb(serialNumber, key);
    }
}

async function updateAllKeys() {
    for (const [serialNumber, deviceData] of deviceKeys) {
        for (const [, key] of deviceData.keys) await updateKey(serialNumber, key);
    }
}
function updateTimelineKeys() {
    forEachKey((serialNumber, key) => { if (key.cid === CID.nowplaying || key.cid === CID.progress) updateKey(serialNumber, key); });
}
function updatePlaybackKeys() {
    forEachKey((serialNumber, key) => { if (key.cid === CID.nowplaying || key.cid === CID.playpause) updateKey(serialNumber, key); });
}
function updateSocialKeys() {
    forEachKey((serialNumber, key) => { if (key.cid === CID.like || key.cid === CID.coin || key.cid === CID.favorite) updateKey(serialNumber, key); });
}
function updateExtrasKeys() {
    forEachKey((serialNumber, key) => { if (key.cid === CID.danmaku) updateKey(serialNumber, key); });
}

async function updateKey(serialNumber, key) {
    try {
        switch (key.cid) {
            case CID.nowplaying: await updateNowPlayingKey(serialNumber, key); break;
            case CID.progress: updateProgressKey(serialNumber, key); break;
            case CID.playpause: updatePlayPauseKey(serialNumber, key); break;
            case CID.like: setMultiState(serialNumber, key, currentState.social.liked ? 1 : 0); break;
            case CID.coin: setMultiState(serialNumber, key, currentState.social.coined ? 1 : 0); break;
            case CID.favorite: setMultiState(serialNumber, key, currentState.social.collected ? 1 : 0); break;
            case CID.danmaku: setMultiState(serialNumber, key, currentState.extras.danmaku ? 1 : 0); break;
        }
    } catch (err) {
        logger.error(`[Plugin] 更新按键 ${key.cid} 失败: ${err.message}`);
    }
}

async function updateNowPlayingKey(serialNumber, key) {
    const d = key.data || {};
    const options = {
        showTitle: d.showTitle !== false,
        showUp: d.showUp !== false,
        showCover: d.showCover !== false,
        showProgress: d.showProgress !== false,
    };
    const width = key.style?.width || 600;
    const buffer = await canvasRenderer.render(currentState, options, width, 60);
    key.style.showImage = true;
    key.style.showIcon = false;
    key.style.showTitle = false;
    key.style.image = `data:image/png;base64,${buffer.toString('base64')}`;
    guardKey(plugin.draw(serialNumber, key, 'draw'), 'draw', serialNumber, key);
}

function updateProgressKey(serialNumber, key) {
    if (Date.now() < sliderHoldUntil) return;       // 用户正在拖动，先不抢
    const { currentTime, totalTime } = currentState.timeline;
    const pct = totalTime > 0 ? Math.max(0, Math.min(100, (currentTime / totalTime) * 100)) : 0;
    setSlider(serialNumber, key, pct);
}

function updatePlayPauseKey(serialNumber, key) {
    setMultiState(serialNumber, key, currentState.playState === 'Playing' ? 1 : 0);
}

// 防止 SDK 调用的异步拒绝变成未捕获 rejection 而拖垮整个插件进程
function guard(p, label) {
    try { if (p && typeof p.then === 'function') p.catch((e) => logger.error(`[Plugin] ${label} 失败: ${e && e.message || e}`)); }
    catch (e) { logger.error(`[Plugin] ${label} 异常: ${e && e.message || e}`); }
}
// 带按键身份的 guard：若 SDK 回「key is not alive」（设备重插/切页后旧句柄失效），
// 就地把该死键从注册表剔除——停止刷它，等下一次 plugin.alive 重新注册（自愈）。
function guardKey(p, label, serialNumber, key) {
    try {
        if (!p || typeof p.then !== 'function') return;
        p.catch((e) => {
            const msg = (e && e.message) || String(e);
            logger.error(`[Plugin] ${label} 失败: ${msg}`);
            if (/not alive/i.test(msg) && serialNumber && key) {
                const dev = deviceKeys.get(serialNumber);
                if (dev && dev.keys.delete(key.uid)) {
                    logger.warn(`[Plugin] 剔除失活按键 ${key.cid} (uid=${key.uid})，等待重新注册`);
                }
            }
        });
    } catch (e) { logger.error(`[Plugin] ${label} 异常: ${e && e.message || e}`); }
}
function setSlider(serialNumber, key, value) {
    try { guardKey(typeof plugin.setSlider === 'function' ? plugin.setSlider(serialNumber, key, value) : plugin.set(serialNumber, key, { value }), 'setSlider', serialNumber, key); }
    catch (e) { logger.error(`[Plugin] setSlider 异常: ${e.message}`); }
}
function setMultiState(serialNumber, key, state) {
    try { guardKey(typeof plugin.setMultiState === 'function' ? plugin.setMultiState(serialNumber, key, state) : plugin.set(serialNumber, key, { state }), 'setMultiState', serialNumber, key); }
    catch (e) { logger.error(`[Plugin] setMultiState 异常: ${e.message}`); }
}
function haptic(serialNumber) {
    try { guard(plugin.sendControlCommand && plugin.sendControlCommand(serialNumber, 'haptic.click'), 'haptic'); } catch {}
}

// ============================================================================
// 按键交互
// ============================================================================

function handleKeyData(serialNumber, data) {
    const key = data.key;
    if (!key) return;
    switch (key.cid) {
        case CID.playpause: onPlayPause(serialNumber, key); break;
        case CID.next: haptic(serialNumber); cdpCmd('next'); break;
        case CID.back: haptic(serialNumber); optimisticSkip(-SKIP_SECONDS); cdpCmd('skip', -SKIP_SECONDS); break;
        case CID.forward: haptic(serialNumber); optimisticSkip(SKIP_SECONDS); cdpCmd('skip', SKIP_SECONDS); break;
        case CID.progress: onSliderMove(serialNumber, key, data.value); break;
        case CID.seekwheel: onWheel(serialNumber, key, data); break;
        case CID.volumewheel: onVolumeWheel(serialNumber, key, data); break;
        case CID.danmaku:
            haptic(serialNumber);
            currentState.extras.danmaku = !currentState.extras.danmaku;   // 乐观翻转
            setMultiState(serialNumber, key, currentState.extras.danmaku ? 1 : 0);
            cdpCmd('danmaku');
            break;
        case CID.like:
            haptic(serialNumber);
            currentState.social.liked = !currentState.social.liked;        // 点赞可直接切换
            setMultiState(serialNumber, key, currentState.social.liked ? 1 : 0);
            cdpCmd('like');
            break;
        case CID.coin:
            haptic(serialNumber); cdpCmd('coin'); break;                    // 可能弹确认框，不乐观翻转
        case CID.favorite:
            haptic(serialNumber); cdpCmd('favorite'); break;               // 打开收藏夹弹窗
    }
}

function onPlayPause(serialNumber, key) {
    haptic(serialNumber);
    const willPlay = currentState.playState !== 'Playing';
    currentState.playState = willPlay ? 'Playing' : 'Paused';
    setMultiState(serialNumber, key, willPlay ? 1 : 0);
    updatePlaybackKeys();
    cdpCmd('toggle');
}

function onSliderMove(serialNumber, key, value) {
    if (typeof value !== 'number') return;
    sliderHoldUntil = Date.now() + SLIDER_HOLD_MS;
    const ratio = Math.max(0, Math.min(1, value / 100));
    const total = currentState.timeline.totalTime || 0;
    currentState.timeline.currentTime = Math.round(ratio * total);
    baseT = ratio * (live.dur || total / 1000); baseAt = Date.now();        // 同步插值基准
    forEachKey((sn, k) => { if (k.cid === CID.nowplaying) updateKey(sn, k); });
    cdpCmd('seekRatio', ratio).then((sec) => { if (typeof sec === 'number' && sec >= 0) { baseT = sec; baseAt = Date.now(); } });
}

// 进度旋钮：累积 delta，节流后相对跳转
function onWheel(serialNumber, key, data) {
    if (data.state === 'start') { haptic(serialNumber); return; }
    if (data.state === 'rolling' && typeof data.delta === 'number') {
        wheelAccum += data.delta;
        if (!wheelFlushTimer) {
            wheelFlushTimer = setTimeout(() => {
                wheelFlushTimer = null;
                const seconds = wheelAccum * WHEEL_STEP_SEC;
                wheelAccum = 0;
                if (seconds === 0) return;
                optimisticSkip(seconds);
                cdpCmd('skip', seconds);
            }, 140);
        }
    }
}

// 音量旋钮：累积 delta，节流后相对调节视频音量，并在条上提示音量
function onVolumeWheel(serialNumber, key, data) {
    if (data.state === 'start') { haptic(serialNumber); return; }
    if (data.state === 'rolling' && typeof data.delta === 'number') {
        volAccum += data.delta;
        if (!volFlushTimer) {
            volFlushTimer = setTimeout(() => {
                volFlushTimer = null;
                const accum = volAccum;
                volAccum = 0;
                const delta = accum * VOL_STEP;
                if (delta === 0) return;
                let v = (currentState.extras.volume || 0) + delta;
                v = Math.max(0, Math.min(1, v));
                currentState.extras.volume = v;
                guard(plugin.showFlexbarSnackbarMessage &&
                    plugin.showFlexbarSnackbarMessage(serialNumber, `音量 ${Math.round(v * 100)}%`, 'info', 'volume_mid', 800),
                    'volSnackbar');
                cdpCmd('volumeDelta', delta);
            }, 120);
        }
    }
}

// 立即在本地推进进度并刷新（命令真正生效前先跟手）
function optimisticSkip(seconds) {
    const tl = currentState.timeline;
    const total = tl.totalTime || 0;
    tl.currentTime = Math.max(0, Math.min(total || Infinity, (tl.currentTime || 0) + seconds * 1000));
    baseT = Math.max(0, (baseT || 0) + seconds); baseAt = Date.now();
    sliderHoldUntil = Date.now() + 600;
    forEachKey((sn, k) => { if (k.cid === CID.nowplaying || k.cid === CID.progress) updateKey(sn, k); });
}

// ============================================================================
// 设备管理
// ============================================================================

function registerDevice(serialNumber, keys) {
    // 权威替换：plugin.alive 给的是「此刻设备上活跃的完整按键集」。只保留本次的键，
    // 自动丢弃因设备重插/切页而失效的旧 uid 句柄——否则会一直往死句柄上画，全报 not alive。
    const map = new Map();
    for (const key of keys || []) map.set(key.uid, key);
    deviceKeys.set(serialNumber, { keys: map });
    logger.info(`[Plugin] 设备 ${serialNumber} 注册 ${map.size} 个活跃按键: ${(keys || []).map((k) => String(k.cid).split('.').pop()).join(',')}`);
    startEngine();
}

function cleanupResources() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (wheelFlushTimer) { clearTimeout(wheelFlushTimer); wheelFlushTimer = null; }
    if (volFlushTimer) { clearTimeout(volFlushTimer); volFlushTimer = null; }
    try { cdp.close(); } catch {}
    deviceKeys.clear();
}

// ============================================================================
// 插件事件
// ============================================================================

plugin.on('plugin.alive', async (payload) => {
    registerDevice(payload.serialNumber, payload.keys);
    setTimeout(() => updateAllKeys(), 500);
});

plugin.on('plugin.data', (payload) => {
    setImmediate(() => {
        try { handleKeyData(payload.serialNumber, payload.data); }
        catch (e) { logger.error(`[Plugin] 交互处理失败: ${e.message}`); }
    });
    return { status: 'success' };
});

plugin.on('device.status', (items) => {
    // 设备拔出/断开：立刻丢弃该设备的按键句柄（已失效）。重连后 plugin.alive 会重新注册。
    if (!Array.isArray(items)) return;
    for (const it of items) {
        if (!it || !it.serialNumber) continue;
        if (it.status === 'disconnected') {
            deviceKeys.delete(it.serialNumber);
            logger.info(`[Plugin] 设备 ${it.serialNumber} 断开，已清除其按键句柄`);
        } else if (it.status === 'connected') {
            logger.info(`[Plugin] 设备 ${it.serialNumber} 已连接，等待 plugin.alive 注册按键`);
        }
    }
});

plugin.on('ui.message', async (payload) => {
    switch (payload.action) {
        case 'getConnectionStatus':
            if (!cdpReady) ensureReachable(true);
            return { connected: cdpReady, currentTitle: currentState.video?.title || null };
        case 'restartBilibiliDebug':
            return await restartBilibiliDebug();
        case 'openUrl':
            return await openUrl(payload.url);
        default:
            return { success: false, error: 'Unknown action' };
    }
});

// 退出哔哩哔哩并以调试端口重启（修复「已运行但没开调试端口」的情况）
function restartBilibiliDebug() {
    // 重启期间先暂停轮询、断开 CDP（避免插件的 CDP 长连接拖慢退出）。
    restarting = true;
    cdpReady = false;
    try { cdp.close(); } catch {}
    // 关键修复（解决「跳一下就没了」）：B 站是 Electron，优雅退出常需 2s 以上；固定 sleep 2 会在
    // 它还没退干净时就 open，只是把正在退出的旧实例「激活一下」，随后退出完成 → 新实例没带端口起来。
    // 这里刻意不用 osascript/AppleEvents（quit/is running 需要 macOS「自动化」授权，FlexDesigner 子进程未必有）：
    // 用 ps 找主进程 PID（grep -F 按字节匹配中文，不受 locale 影响）→ SIGTERM 优雅退出 →
    // 轮询等它「真正消失」→ 仍在则 SIGKILL 兜底 → 再带调试端口全新 open。kill 的是自身进程，无需任何授权。
    const mainProc = JSON.stringify(`${APP_NAME}.app/Contents/MacOS/${APP_NAME}`);  // 仅匹配主进程
    const findPid = `ps -ax -o pid=,command= | grep -F ${mainProc} | grep -v grep | awk '{print $1}' | head -1`;
    const cmd =
        `pid=$(${findPid}); ` +
        `if [ -n "$pid" ]; then ` +
        `  kill "$pid" 2>/dev/null; ` +
        `  for i in $(seq 1 40); do ps -p "$pid" >/dev/null 2>&1 || break; sleep 0.25; done; ` +
        `  if ps -p "$pid" >/dev/null 2>&1; then kill -9 "$pid" 2>/dev/null; sleep 1; fi; ` +
        `fi; ` +
        `open -a "${APP_NAME}" --args --remote-debugging-port=${CDP_PORT}`;
    return new Promise((resolve) => {
        exec(cmd, { timeout: 20000, env: cleanLaunchEnv() }, (error) => {
            restarting = false;   // 恢复轮询，pollLoop 会连到新实例
            if (error) { logger.error(`[Plugin] 重启哔哩哔哩失败: ${error.message}`); resolve({ success: false, error: error.message }); }
            else { logger.info('[Plugin] 已带调试端口重启哔哩哔哩'); resolve({ success: true }); }
        });
    });
}

function openUrl(url) {
    const platform = process.platform;
    const cmd = platform === 'win32' ? `start "" "${url}"` : platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    return new Promise((resolve) => exec(cmd, (e) => resolve({ success: !e, error: e?.message })));
}

// 安全网：任何未捕获的异常/拒绝都只记录，绝不让插件进程崩溃重启
process.on('uncaughtException', (e) => { try { logger.error('[Plugin] uncaughtException: ' + (e && e.stack || e)); } catch {} });
process.on('unhandledRejection', (e) => { try { logger.error('[Plugin] unhandledRejection: ' + (e && e.stack || e)); } catch {} });

process.on('SIGINT', () => { cleanupResources(); process.exit(0); });
process.on('SIGTERM', () => { cleanupResources(); process.exit(0); });

plugin.start();
