'use strict';
/**
 * 极简 Chrome DevTools Protocol (CDP) 客户端
 * ============================================================================
 * 哔哩哔哩 Mac 客户端是一个 Electron 应用（Electron 22 / Chrome 108）。用
 * `--remote-debugging-port` 启动后，它会在 127.0.0.1:<port> 暴露 CDP。其中
 * 名为 `player.html` 的页面承载真正的 <video> 元素——我们连上去后即可：
 *   - 读取 video.currentTime / duration / paused（真实播放状态、进度）
 *   - 写入 video.currentTime（精确跳转 = 进度条拖拽）
 *   - 调用 video.play() / video.pause()（播放/暂停）
 *   - 点击播放器里的「下一P/上一P」按钮（下一集/上一集）
 *
 * 本模块只实现我们需要的一点点 CDP：解析目标页面、建立 WebSocket、
 * Runtime.enable，然后用 Runtime.evaluate 执行表达式并取回返回值。
 * 断线会在下一次 evaluate 时自动重连。
 */

const http = require('http');
const WebSocket = require('ws');

class CDPClient {
    /**
     * @param {object} opts
     * @param {string} opts.host    CDP 主机，默认 127.0.0.1
     * @param {number} opts.port    CDP 端口，默认 9222
     * @param {string} opts.urlMatch 目标页面 url 包含的子串，默认 'player.html'
     * @param {function} opts.log
     * @param {function} opts.debug
     */
    constructor({ host = '127.0.0.1', port = 9222, urlMatch = 'player.html', log = () => {}, debug = () => {} } = {}) {
        this.host = host;
        this.port = port;
        this.urlMatch = urlMatch;
        this.log = log;
        this.debug = debug;

        this.ws = null;
        this.targetId = null;
        this.currentUrl = null;        // 当前所连页面的 url（用于判断是否在 player.html 播放页）
        this.nextId = 1;
        this.pending = new Map();      // id -> { resolve, reject, timer }
        this.connecting = null;        // 进行中的连接 Promise（防止并发重连）
        this.evalTimeoutMs = 5000;
    }

    // ---- HTTP: 列出可调试目标 ---------------------------------------------
    _httpJSON(path) {
        return new Promise((resolve, reject) => {
            const req = http.get({ host: this.host, port: this.port, path, timeout: 3000 }, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error('CDP JSON 解析失败: ' + e.message)); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('CDP HTTP 超时')));
            req.on('error', reject);
        });
    }

    /** 探测 CDP 是否在线（用于启动等待）。 */
    async isReachable() {
        try { await this._httpJSON('/json/version'); return true; }
        catch { return false; }
    }

    async _resolvePlayerTarget() {
        const list = await this._httpJSON('/json/list');
        // 优先匹配 player.html，其次任何带 <video> 嫌疑的 page
        const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        let target = pages.find((t) => (t.url || '').includes(this.urlMatch));
        if (!target) target = pages.find((t) => (t.url || '').includes('bilibili'));
        if (!target) throw new Error(`未找到目标页面（包含 "${this.urlMatch}"）。共有 ${pages.length} 个可调试页面。`);
        return target;
    }

    // ---- WebSocket: 建立连接 ----------------------------------------------
    async _connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        if (this.connecting) return this.connecting;

        this.connecting = (async () => {
            const target = await this._resolvePlayerTarget();
            await this._connectTo(target);
        })();

        try { await this.connecting; }
        finally { this.connecting = null; }
    }

    // 连接到指定目标页面（建立 ws + 开 Runtime 域）。
    async _connectTo(target) {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
            const onOpen = () => {
                ws.removeListener('error', onErr);
                this.ws = ws;
                this.targetId = target.id;
                this.currentUrl = target.url || '';
                this._wire(ws);
                this.debug(`CDP 已连接页面 ${target.id} (${(target.url || '').slice(0, 60)})`);
                resolve();
            };
            const onErr = (e) => { ws.removeListener('open', onOpen); reject(e); };
            ws.once('open', onOpen);
            ws.once('error', onErr);
        });
        // 打开 Runtime 域（evaluate 需要）
        await this._send('Runtime.enable', {});
    }

    // 若当前没连在 player.html 播放页、但现在出现了 player.html 目标，则切过去。
    // 解决：B 站刚启动时只有首页（bilibili 域名，被 fallback 连上），用户随后播放视频才出现 player.html，
    // 旧连接若粘在首页就读不到正在播放、控制也无效。需在播放页出现时及时切换目标。
    async _retargetToPlayerIfNeeded() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.currentUrl && this.currentUrl.includes(this.urlMatch)) return;   // 已在播放页，不动
        let list;
        try { list = await this._httpJSON('/json/list'); } catch { return; }
        const player = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url || '').includes(this.urlMatch));
        if (player && player.id !== this.targetId) {
            this.debug(`发现播放页，切换目标 → ${player.id}`);
            try { this.ws.terminate(); } catch {}
            this.ws = null; this.targetId = null; this.currentUrl = null;
            await this._connectTo(player);
        }
    }

    _wire(ws) {
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
                else resolve(msg.result);
            }
        });
        const drop = (why) => {
            if (this.ws === ws) { this.ws = null; this.targetId = null; this.currentUrl = null; }
            for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('CDP 连接断开: ' + why)); }
            this.pending.clear();
            this.debug('CDP 连接关闭: ' + why);
        };
        ws.on('close', () => drop('close'));
        ws.on('error', (e) => drop(e.message));
    }

    _send(method, params) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP 未连接'));
            const id = this.nextId++;
            const timer = setTimeout(() => {
                if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }
            }, this.evalTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * 在目标页面执行 JS 表达式并返回其值（按值序列化）。
     * 支持 async 表达式（awaitPromise）。
     * @param {string} expression
     * @returns {Promise<any>}
     */
    async evaluate(expression, opts = {}) {
        // 最多重连一次
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this._connect();
                await this._retargetToPlayerIfNeeded();
                const res = await this._send('Runtime.evaluate', {
                    expression,
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: !!opts.userGesture,   // 全屏等需要用户手势的 API 必须置 true
                    timeout: this.evalTimeoutMs,
                });
                if (res && res.exceptionDetails) {
                    const ex = res.exceptionDetails;
                    const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || '页面内异常';
                    throw new Error('页面内异常: ' + String(msg).split('\n')[0]);
                }
                return res && res.result ? res.result.value : undefined;
            } catch (e) {
                // 连接类错误：丢弃当前 ws，下一轮重连
                if (/未连接|连接断开|超时|ECONNREFUSED|未找到目标/.test(e.message) && attempt === 0) {
                    try { if (this.ws) this.ws.terminate(); } catch {}
                    this.ws = null; this.targetId = null;
                    continue;
                }
                throw e;
            }
        }
    }

    close() {
        try { if (this.ws) this.ws.terminate(); } catch {}
        this.ws = null;
        this.targetId = null;
        this.currentUrl = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('客户端关闭')); }
        this.pending.clear();
    }
}

module.exports = { CDPClient };
