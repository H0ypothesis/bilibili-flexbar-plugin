/**
 * Bilibili Plugin for FlexDesigner
 * ============================================================================
 * FlexBar 端插件（运行在 FlexDesigner 的 Node 子进程里）。它作为 WebSocket
 * 客户端连接到 macos-bridge (ws://127.0.0.1:35020)，接收播放状态、下发控制命令。
 *
 * 按键：
 *   nowplaying  正在播放（封面/标题/UP/进度，Canvas 绘制）
 *   progress    进度条滑块（拖拽 = 跳转）        ← slider
 *   playpause   播放 / 暂停                      ← multiState
 *   previous    上一集（上一P）
 *   next        下一集（下一P）
 *   back        快退 15 秒
 *   forward     快进 15 秒
 *   seekwheel   旋钮拖动微调进度                  ← wheel
 */

const { plugin, logger } = require("@eniac/flexdesigner");
const WebSocket = require('ws');
const CanvasRenderer = require('./canvas-renderer');
const { exec } = require('child_process');

// ============================================================================
// 常量
// ============================================================================

const UUID = 'com.eniac.bilibiliplugin';
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

const WS_URL = `ws://127.0.0.1:${process.env.BILIBILI_WS_PORT || 35020}`;
const SKIP_SECONDS = 15;            // 快进/快退步长
const WHEEL_STEP_SEC = 2;           // 进度旋钮每格秒数
const VOL_STEP = 0.02;              // 音量旋钮灵敏度：每单位 delta 改变的音量（越小越不灵敏/行程越长）
const SLIDER_HOLD_MS = 1200;        // 拖动后暂停回写滑块，避免与用户抢

// ============================================================================
// 状态
// ============================================================================

let ws = null;
let reconnectTimer = null;
let isConnected = false;

let currentState = {
    video: null,                    // { title, up, coverBase64 }
    playState: 'Stopped',
    timeline: { currentTime: 0, totalTime: 0 },
    social: { liked: false, coined: false, collected: false, likeCount: '' },
    extras: { volume: 1, muted: false, danmaku: null },
};

const deviceKeys = new Map();       // serialNumber -> { keys: Map<uid,key> }
const canvasRenderer = new CanvasRenderer(logger);

// 滑块拖动抑制窗口
let sliderHoldUntil = 0;
// 旋钮累积
let wheelAccum = 0;
let wheelFlushTimer = null;

// ============================================================================
// WebSocket（连接 bridge）
// ============================================================================

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
        ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            isConnected = true;
            logger.info('[Plugin] 已连接桥接服务');
            sendCommand({ type: 'GetState' });
        });
        ws.on('message', (data) => {
            try { handleWebSocketMessage(JSON.parse(data.toString())); }
            catch (e) { logger.error(`[Plugin] 解析消息失败: ${e.message}`); }
        });
        ws.on('close', () => { isConnected = false; scheduleReconnect(); });
        ws.on('error', (err) => { isConnected = false; logger.error(`[Plugin] WebSocket 错误: ${err.message}`); });
    } catch (err) {
        logger.error(`[Plugin] 创建 WebSocket 失败: ${err.message}`);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, 5000);
}

function sendCommand(cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
    else logger.warn('[Plugin] 桥接未连接，命令未发送: ' + cmd.type);
}

// ============================================================================
// 消息处理
// ============================================================================

function handleWebSocketMessage(msg) {
    switch (msg.type) {
        case 'FullState':
            currentState.video = msg.data.video;
            currentState.playState = msg.data.playState;
            currentState.timeline = msg.data.timeline || { currentTime: 0, totalTime: 0 };
            if (msg.data.social) currentState.social = msg.data.social;
            if (msg.data.extras) currentState.extras = msg.data.extras;
            updateAllKeys();
            break;

        case 'SocialUpdate':
            currentState.social = msg.data || currentState.social;
            updateSocialKeys();
            break;

        case 'ExtrasUpdate':
            currentState.extras = msg.data || currentState.extras;
            updateExtrasKeys();
            break;
        case 'VideoUpdate':
            currentState.video = msg.data;
            updateAllKeys();
            break;
        case 'PlayStateUpdate':
            currentState.playState = msg.data.status;
            updatePlaybackKeys();
            break;
        case 'TimelineUpdate':
            currentState.timeline = { currentTime: msg.data.currentTime, totalTime: msg.data.totalTime };
            updateTimelineKeys();
            break;
    }
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

// 仅刷新与进度相关的按键（nowplaying / progress / seekwheel）
function updateTimelineKeys() {
    forEachKey((serialNumber, key) => {
        if (key.cid === CID.nowplaying || key.cid === CID.progress) updateKey(serialNumber, key);
    });
}

// 仅刷新播放状态相关（nowplaying 封面遮罩 / playpause 图标）
function updatePlaybackKeys() {
    forEachKey((serialNumber, key) => {
        if (key.cid === CID.nowplaying || key.cid === CID.playpause) updateKey(serialNumber, key);
    });
}

// 仅刷新社交按键（点赞/投币/收藏 高亮）
function updateSocialKeys() {
    forEachKey((serialNumber, key) => {
        if (key.cid === CID.like || key.cid === CID.coin || key.cid === CID.favorite) updateKey(serialNumber, key);
    });
}

// 仅刷新弹幕按键高亮
function updateExtrasKeys() {
    forEachKey((serialNumber, key) => {
        if (key.cid === CID.danmaku) updateKey(serialNumber, key);
    });
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
    const height = 60;
    const buffer = await canvasRenderer.render(currentState, options, width, height);
    key.style.showImage = true;
    key.style.showIcon = false;
    key.style.showTitle = false;
    key.style.image = `data:image/png;base64,${buffer.toString('base64')}`;
    guard(plugin.draw(serialNumber, key, 'draw'), 'draw');
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

// SDK 兼容封装（全部吞掉异常/拒绝）
function setSlider(serialNumber, key, value) {
    try { guard(typeof plugin.setSlider === 'function' ? plugin.setSlider(serialNumber, key, value) : plugin.set(serialNumber, key, { value }), 'setSlider'); }
    catch (e) { logger.error(`[Plugin] setSlider 异常: ${e.message}`); }
}
function setMultiState(serialNumber, key, state) {
    try { guard(typeof plugin.setMultiState === 'function' ? plugin.setMultiState(serialNumber, key, state) : plugin.set(serialNumber, key, { state }), 'setMultiState'); }
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
        case CID.next: haptic(serialNumber); sendCommand({ type: 'NextEpisode' }); break;
        case CID.back: haptic(serialNumber); optimisticSkip(-SKIP_SECONDS); sendCommand({ type: 'SkipBackward', seconds: SKIP_SECONDS }); break;
        case CID.forward: haptic(serialNumber); optimisticSkip(SKIP_SECONDS); sendCommand({ type: 'SkipForward', seconds: SKIP_SECONDS }); break;
        case CID.progress: onSliderMove(serialNumber, key, data.value); break;
        case CID.seekwheel: onWheel(serialNumber, key, data); break;
        case CID.volumewheel: onVolumeWheel(serialNumber, key, data); break;
        case CID.danmaku:
            haptic(serialNumber);
            currentState.extras.danmaku = !currentState.extras.danmaku;   // 乐观翻转
            setMultiState(serialNumber, key, currentState.extras.danmaku ? 1 : 0);
            sendCommand({ type: 'ToggleDanmaku' });
            break;
        case CID.like:
            haptic(serialNumber);
            // 点赞是直接切换，乐观翻转高亮（桥接随后会回报真实状态）
            currentState.social.liked = !currentState.social.liked;
            setMultiState(serialNumber, key, currentState.social.liked ? 1 : 0);
            sendCommand({ type: 'Like' });
            break;
        case CID.coin:
            // 投币可能弹确认框（取决于 B 站设置），不做乐观翻转，等真实状态
            haptic(serialNumber);
            sendCommand({ type: 'Coin' });
            break;
        case CID.favorite:
            // 收藏会打开收藏夹弹窗，不做乐观翻转
            haptic(serialNumber);
            sendCommand({ type: 'Favorite' });
            break;
    }
}

function onPlayPause(serialNumber, key) {
    haptic(serialNumber);
    const willPlay = currentState.playState !== 'Playing';
    currentState.playState = willPlay ? 'Playing' : 'Paused';
    setMultiState(serialNumber, key, willPlay ? 1 : 0);
    updatePlaybackKeys();
    sendCommand({ type: 'TogglePlay' });
}

function onSliderMove(serialNumber, key, value) {
    if (typeof value !== 'number') return;
    sliderHoldUntil = Date.now() + SLIDER_HOLD_MS;
    const ratio = Math.max(0, Math.min(1, value / 100));
    // 乐观更新本地进度（让 nowplaying 立即跟手）
    const total = currentState.timeline.totalTime || 0;
    currentState.timeline.currentTime = Math.round(ratio * total);
    forEachKey((sn, k) => { if (k.cid === CID.nowplaying) updateKey(sn, k); });
    sendCommand({ type: 'SeekRatio', ratio });
}

// 旋钮：累积 delta，节流后一次性相对跳转
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
                sendCommand({ type: seconds >= 0 ? 'SkipForward' : 'SkipBackward', seconds: Math.abs(seconds) });
            }, 140);
        }
    }
}

// 音量旋钮：累积 delta，节流后相对调节视频音量，并在条上提示音量
let volAccum = 0;
let volFlushTimer = null;
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
                logger.info(`[Plugin] 音量旋钮 accum=${accum.toFixed(2)} Δ=${(delta * 100).toFixed(1)}% -> ${Math.round(v * 100)}%`);
                guard(plugin.showFlexbarSnackbarMessage &&
                    plugin.showFlexbarSnackbarMessage(serialNumber, `音量 ${Math.round(v * 100)}%`, 'info', 'volume_mid', 800),
                    'volSnackbar');
                sendCommand({ type: 'AdjustVolume', delta });
            }, 120);
        }
    }
}

// 立即在本地推进进度并刷新（命令真正生效前先跟手）
function optimisticSkip(seconds) {
    const tl = currentState.timeline;
    const total = tl.totalTime || 0;
    tl.currentTime = Math.max(0, Math.min(total || Infinity, (tl.currentTime || 0) + seconds * 1000));
    sliderHoldUntil = Date.now() + 600;
    forEachKey((sn, k) => { if (k.cid === CID.nowplaying || k.cid === CID.progress) updateKey(sn, k); });
}

// ============================================================================
// 设备管理
// ============================================================================

function registerDevice(serialNumber, keys) {
    if (!deviceKeys.has(serialNumber)) deviceKeys.set(serialNumber, { keys: new Map() });
    const deviceData = deviceKeys.get(serialNumber);
    for (const key of keys) deviceData.keys.set(key.uid, key);
    connectWebSocket();
}

function cleanupResources() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (wheelFlushTimer) { clearTimeout(wheelFlushTimer); wheelFlushTimer = null; }
    if (volFlushTimer) { clearTimeout(volFlushTimer); volFlushTimer = null; }
    if (ws) { ws.close(); ws = null; }
    deviceKeys.clear();
    isConnected = false;
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

plugin.on('device.status', () => { /* 设备重连时 plugin.alive 会重新注册 */ });

plugin.on('ui.message', async (payload) => {
    switch (payload.action) {
        case 'getConnectionStatus':
            if (!isConnected) connectWebSocket();
            return { connected: isConnected, currentTitle: currentState.video?.title || null };
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
    const app = process.env.BILIBILI_APP || '哔哩哔哩';
    const port = process.env.BILIBILI_CDP_PORT || 9222;
    const cmd = `osascript -e 'tell application "${app}" to quit' >/dev/null 2>&1; sleep 1; ` +
        `pkill -f "${app}.app" >/dev/null 2>&1; sleep 1; ` +
        `open -a "${app}" --args --remote-debugging-port=${port} --remote-allow-origins='*'`;
    return new Promise((resolve) => {
        exec(cmd, (error) => {
            if (error) { logger.error(`[Plugin] 重启哔哩哔哩失败: ${error.message}`); resolve({ success: false, error: error.message }); }
            else resolve({ success: true });
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
