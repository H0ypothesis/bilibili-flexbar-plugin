#!/usr/bin/env node
'use strict';
/**
 * macOS 哔哩哔哩桥接服务 (Bilibili macOS Bridge)
 * ============================================================================
 * FlexBar 的 BilibiliPlugin 是一个 WebSocket 客户端，它连接 ws://127.0.0.1:35020，
 * 期待一个"服务端"推送播放状态、并接收控制命令。本服务就是这个服务端。
 *
 * 数据来源不是系统「正在播放」（哔哩哔哩 Electron 客户端并不上报），而是直接
 * 驱动客户端内嵌的网页播放器：
 *
 *   哔哩哔哩.app(Electron, --remote-debugging-port)
 *        │  Chrome DevTools Protocol (player.html 里的 <video>)
 *        ▼
 *     本服务  ──►  读取 currentTime/duration/paused、标题/UP/封面
 *        │     ◄──  Play/Pause/Seek/下一集… 命令翻译为 video 操作
 *        ▼  ws://127.0.0.1:35020
 *   FlexBar 插件
 *
 * 关键能力：
 *   - 进度条拖拽  = 设置 video.currentTime（逐帧精确）
 *   - 播放 / 暂停 = video.play() / video.pause()
 *   - 下一集 / 上一集 = 点击播放器「下一P/上一P」按钮
 *   - 快进 / 快退 = video.currentTime ± N 秒
 */

const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { CDPClient } = require('./cdp');
const { STATE_EXPR, cmdExpr, bvidFromHref, fetchVideoMeta } = require('./bilibili');

// ============================================================================
// 配置
// ============================================================================

const WS_HOST = process.env.BILIBILI_WS_HOST || '127.0.0.1';
const WS_PORT = parseInt(process.env.BILIBILI_WS_PORT || '35020', 10);
const CDP_HOST = process.env.BILIBILI_CDP_HOST || '127.0.0.1';
const CDP_PORT = parseInt(process.env.BILIBILI_CDP_PORT || '9222', 10);
const APP_NAME = process.env.BILIBILI_APP || '哔哩哔哩';
const AUTOLAUNCH = process.env.BILIBILI_NO_AUTOLAUNCH ? false : true;
const POLL_MS = parseInt(process.env.BILIBILI_POLL_MS || '300', 10);
const DEBUG = !!process.env.DEBUG;

// ============================================================================
// 日志
// ============================================================================

function ts() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function log(...a) { console.error(`[${ts()}] [bridge]`, ...a); }
function debug(...a) { if (DEBUG) console.error(`[${ts()}] [debug]`, ...a); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 状态
// ============================================================================

const cdp = new CDPClient({ host: CDP_HOST, port: CDP_PORT, urlMatch: 'player.html', log, debug });

// 最近一次从页面读到的实时状态
let live = { hasVideo: false, t: 0, dur: 0, paused: true, rate: 1, href: '', docTitle: '', up: null };
// 按 bvid 缓存的权威元数据
let meta = null;          // { bvid, title, up, coverBase64, durationSec }
let currentBvid = null;
let metaToken = 0;

// 进度插值基准（让进度在两次轮询之间也平滑前进）
let baseT = 0, baseAt = Date.now();

// 去重缓存
let lastVideoKey, lastPlayState, lastTimelineKey, lastSocialKey, lastExtrasKey;

// ============================================================================
// 派生：翻译成插件协议
// ============================================================================

function deriveVideo() {
    // 标题/UP/封面优先用接口元数据，DOM 兜底
    const title = (meta && meta.title) || live.docTitle || '';
    if (!live.hasVideo && !title) return null;
    return {
        title,
        up: (meta && meta.up) || live.up || '',
        coverBase64: (meta && meta.coverBase64) || null,
    };
}

function derivePlayState() {
    if (!live.hasVideo) return 'Stopped';
    return live.paused ? 'Paused' : 'Playing';
}

function deriveSocial() {
    const s = live.social || {};
    return {
        liked: !!(s.like && s.like.on),
        coined: !!(s.coin && s.coin.on),
        collected: !!(s.fav && s.fav.on),
        likeCount: (s.like && s.like.n) || '',
    };
}

function deriveExtras() {
    return {
        volume: typeof live.vol === 'number' ? live.vol : 1,
        muted: !!live.muted,
        danmaku: live.danmaku === null || live.danmaku === undefined ? null : !!live.danmaku,
    };
}

function interpolatedSec() {
    let pos = baseT;
    if (live.hasVideo && !live.paused && live.rate) {
        pos += ((Date.now() - baseAt) / 1000) * live.rate;
    }
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
// WebSocket 服务端（面向插件）
// ============================================================================

const clients = new Set();
let wss = null;

function startServer() {
    wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });
    wss.on('listening', () => log(`WebSocket 服务已启动: ws://${WS_HOST}:${WS_PORT}`));
    wss.on('connection', (socket, req) => {
        clients.add(socket);
        log(`插件已连接 (${req.socket.remoteAddress})，当前连接数 ${clients.size}`);
        sendFullState(socket);
        socket.on('message', (data) => {
            let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
            handleClientCommand(msg).catch((e) => debug('命令处理失败:', e.message));
        });
        socket.on('close', () => { clients.delete(socket); log(`插件已断开，当前连接数 ${clients.size}`); });
        socket.on('error', (e) => debug('客户端 socket 错误:', e.message));
    });
    wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE') { log(`端口 ${WS_PORT} 已被占用，是否已有其它桥接在运行？`); process.exit(1); }
        log('WebSocket 服务错误:', err.message);
    });
}

function send(socket, obj) { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj)); }
function broadcast(obj) { const t = JSON.stringify(obj); for (const s of clients) if (s.readyState === s.OPEN) s.send(t); }

function sendFullState(socket) {
    send(socket, { type: 'FullState', data: { video: deriveVideo(), playState: derivePlayState(), timeline: deriveTimeline(), social: deriveSocial(), extras: deriveExtras() } });
}

// ---- 插件 → 本服务 的命令 -------------------------------------------------

async function handleClientCommand(msg) {
    const type = msg && msg.type;
    debug('收到命令:', type, msg.positionMs ?? msg.ratio ?? msg.seconds ?? '');
    try {
        switch (type) {
            case 'GetState': for (const s of clients) sendFullState(s); break;
            case 'Play': await cdp.evaluate(cmdExpr('play')); break;
            case 'Pause': await cdp.evaluate(cmdExpr('pause')); break;
            case 'TogglePlay': await cdp.evaluate(cmdExpr('toggle')); break;
            case 'Seek': {                 // 绝对跳转(毫秒)
                const sec = Math.max(0, (Number(msg.positionMs) || 0) / 1000);
                const got = await cdp.evaluate(cmdExpr('seekSeconds', sec));
                applyOptimisticSeek(got, sec); break;
            }
            case 'SeekRatio': {            // 0..1
                const r = Math.max(0, Math.min(1, Number(msg.ratio) || 0));
                const got = await cdp.evaluate(cmdExpr('seekRatio', r));
                applyOptimisticSeek(got, r * (live.dur || 0)); break;
            }
            case 'SkipForward': { const s = Number(msg.seconds) || 15; const got = await cdp.evaluate(cmdExpr('skip', s)); applyOptimisticSeek(got); break; }
            case 'SkipBackward': { const s = Number(msg.seconds) || 15; const got = await cdp.evaluate(cmdExpr('skip', -s)); applyOptimisticSeek(got); break; }
            case 'NextEpisode': { const r = await cdp.evaluate(cmdExpr('next')); debug('下一集 ->', r); break; }
            case 'AdjustVolume': { const v = await cdp.evaluate(cmdExpr('volumeDelta', Number(msg.delta) || 0)); applyOptimisticVolume(v); break; }
            case 'SetVolume': { const v = await cdp.evaluate(cmdExpr('volume', Number(msg.volume) || 0)); applyOptimisticVolume(v); break; }
            case 'ToggleMute': await cdp.evaluate(cmdExpr('mute')); break;
            case 'ToggleDanmaku': { const r = await cdp.evaluate(cmdExpr('danmaku')); debug('弹幕 ->', r); break; }
            case 'Like': await cdp.evaluate(cmdExpr('like')); break;
            case 'Coin': await cdp.evaluate(cmdExpr('coin')); break;
            case 'Favorite': await cdp.evaluate(cmdExpr('favorite')); break;
            case 'SetRate': await cdp.evaluate(cmdExpr('rate', Number(msg.rate) || 1)); break;
            default: debug('未知命令:', type);
        }
    } catch (e) {
        log(`命令 ${type} 执行失败: ${e.message}`);
    }
}

// 调音量后即时回报，减少手感延迟
function applyOptimisticVolume(returnedVol) {
    if (typeof returnedVol !== 'number' || returnedVol < 0) return;
    live.vol = returnedVol;
    const extras = deriveExtras();
    lastExtrasKey = JSON.stringify(extras);
    broadcast({ type: 'ExtrasUpdate', data: extras });
}

// 命令产生即时位置变化时，立即更新插值基准并广播，减少手感延迟
function applyOptimisticSeek(returnedSec, fallbackSec) {
    let s = typeof returnedSec === 'number' && returnedSec >= 0 ? returnedSec : fallbackSec;
    if (typeof s !== 'number' || s < 0) return;
    live.t = s; baseT = s; baseAt = Date.now();
    broadcastTimeline(true);
}

// ============================================================================
// 状态轮询（CDP）
// ============================================================================

function publish() {
    const video = deriveVideo();
    const vKey = JSON.stringify(video);
    if (vKey !== lastVideoKey) { lastVideoKey = vKey; broadcast({ type: 'VideoUpdate', data: video }); }

    const ps = derivePlayState();
    if (ps !== lastPlayState) { lastPlayState = ps; broadcast({ type: 'PlayStateUpdate', data: { status: ps } }); }

    const social = deriveSocial();
    const socialKey = JSON.stringify(social);
    if (socialKey !== lastSocialKey) { lastSocialKey = social ? socialKey : undefined; broadcast({ type: 'SocialUpdate', data: social }); }

    const extras = deriveExtras();
    const extrasKey = JSON.stringify(extras);
    if (extrasKey !== lastExtrasKey) { lastExtrasKey = extrasKey; broadcast({ type: 'ExtrasUpdate', data: extras }); }

    broadcastTimeline(false);
}

function broadcastTimeline(force) {
    const tl = deriveTimeline();
    const key = `${Math.round(tl.currentTime / 250)}:${tl.totalTime}`;
    if (!force && key === lastTimelineKey) return;
    lastTimelineKey = key;
    broadcast({ type: 'TimelineUpdate', data: tl });
}

async function onSnapshot(s) {
    if (!s || s.error) { debug('快照异常:', s && s.error); return; }

    if (!s.hasVideo) {
        if (live.hasVideo) debug('当前无播放');
        live = { hasVideo: false, t: 0, dur: 0, paused: true, rate: 1, href: s.href || '', docTitle: '', up: null, social: null };
        currentBvid = null; meta = null;
        baseT = 0; baseAt = Date.now();
        publish();
        return;
    }

    live = {
        hasVideo: true,
        t: Number(s.t) || 0,
        dur: Number(s.dur) || 0,
        paused: !!s.paused,
        rate: Number(s.rate) || 1,
        href: s.href || '',
        docTitle: s.docTitle || '',
        up: s.up || null,
        social: s.social || null,
        vol: typeof s.vol === 'number' ? s.vol : 1,
        muted: !!s.muted,
        danmaku: (s.danmaku === null || s.danmaku === undefined) ? null : !!s.danmaku,
    };
    // 重新校准插值基准
    baseT = live.t; baseAt = Date.now();

    // 换视频 → 异步拉取元数据（标题/UP/封面）
    const bvid = bvidFromHref(live.href);
    if (bvid && bvid !== currentBvid) {
        currentBvid = bvid;
        meta = null; // 先清空，避免显示上一条
        const token = ++metaToken;
        fetchVideoMeta(bvid)
            .then((m) => { if (token === metaToken) { meta = m; log(`元数据: ${m.title} — ${m.up}${m.coverBase64 ? ' (含封面)' : ''}`); publish(); } })
            .catch((e) => debug('元数据拉取失败:', e.message));
    } else if (!bvid && currentBvid) {
        currentBvid = null; meta = null;
    }

    publish();
}

let pollTimer = null;
async function pollLoop() {
    try {
        const snap = await cdp.evaluate(STATE_EXPR);
        await onSnapshot(snap);
    } catch (e) {
        // CDP 不可达：标记无播放并尝试恢复
        if (live.hasVideo) { live.hasVideo = false; publish(); }
        debug('轮询失败:', e.message);
        await ensureReachable(false);
    } finally {
        pollTimer = setTimeout(pollLoop, POLL_MS);
    }
}

// ============================================================================
// 哔哩哔哩 App 启动管理
// ============================================================================

function launchApp() {
    log(`尝试以调试端口启动「${APP_NAME}」…`);
    const p = spawn('open', ['-a', APP_NAME, '--args', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'], { stdio: 'ignore', detached: true });
    p.on('error', (e) => log('启动 App 失败:', e.message));
    p.unref();
}

/** 确保 CDP 可达；必要时（且允许）尝试启动 App。 */
async function ensureReachable(tryLaunch = true) {
    if (await cdp.isReachable()) return true;
    if (tryLaunch && AUTOLAUNCH) launchApp();
    for (let i = 0; i < 40; i++) {       // 最多等 ~20s
        await delay(500);
        if (await cdp.isReachable()) { log('已连接到哔哩哔哩调试端口'); return true; }
    }
    return false;
}

// ============================================================================
// 退出清理
// ============================================================================

function cleanup() {
    if (pollTimer) clearTimeout(pollTimer);
    try { cdp.close(); } catch {}
    if (wss) wss.close();
}
process.on('SIGINT', () => { log('收到 SIGINT，退出…'); cleanup(); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出…'); cleanup(); process.exit(0); });

// ============================================================================
// 启动
// ============================================================================

(async () => {
    log('哔哩哔哩 macOS 桥接服务启动中…');
    log(`CDP: ${CDP_HOST}:${CDP_PORT}   App: ${APP_NAME}   自动启动: ${AUTOLAUNCH ? '是' : '否'}`);
    startServer();
    const ok = await ensureReachable(true);
    if (!ok) {
        log('⚠️  暂时连不上哔哩哔哩的调试端口。');
        log(`   请确保「${APP_NAME}」以调试模式启动：先完全退出它，再运行 macos-bridge/start.sh，`);
        log(`   或手动执行: open -a "${APP_NAME}" --args --remote-debugging-port=${CDP_PORT}`);
        log('   服务会持续重试……');
    }
    pollLoop();
})();
