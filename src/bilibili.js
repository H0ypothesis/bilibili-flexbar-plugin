'use strict';
/**
 * 哔哩哔哩 播放器适配层
 * ============================================================================
 * 这里集中两类逻辑：
 *   1) 在 player.html 页面里执行的 JS 表达式（读状态 / 发命令）。
 *   2) 通过哔哩哔哩公开接口按 bvid 拉取「权威」元数据（标题/UP主/封面/时长），
 *      因为 DOM 抓取容易随前端改版而失效，而 view 接口稳定且包含封面图。
 *
 * 实时播放位置（currentTime / paused / duration）必须取自真实 <video> 元素，
 * 静态信息（标题/UP/封面）则优先取自接口，DOM 仅作兜底。
 */

const https = require('https');

// ---- 页面内表达式 ---------------------------------------------------------

// 读取当前播放状态。返回一个可序列化对象。
const STATE_EXPR = `(function(){
  try {
    const href = location.href;
    const v = document.querySelector('video');
    if (!v) return { href: href, hasVideo: false };
    let up = null;
    const upEl = document.querySelector('.bpx-player-video-info-name, .up-name, [class*="up-name"], [class*="author"]');
    if (upEl) up = (upEl.textContent || '').trim().slice(0, 60);
    const dur = isFinite(v.duration) ? v.duration : 0;
    return {
      href: href,
      hasVideo: true,
      t: v.currentTime || 0,
      dur: dur,
      paused: !!v.paused,
      ended: !!v.ended,
      rate: v.playbackRate || 1,
      docTitle: (document.title || '').replace(/[-_\\s]*bilibili\\s*$/i, '').trim(),
      up: up,
      vol: (typeof v.volume === 'number') ? v.volume : 1,
      muted: !!v.muted,
      danmaku: (function(){ var i=document.querySelector('.bui-danmaku-switch-input,.bpx-player-dm-switch-input'); return i ? !!i.checked : null; })(),
      fullscreen: !!document.fullscreenElement,
      subtitle: (function(){
        try {
          function grp(sel){ var g=document.querySelector(sel); if(!g) return ''; var t=g.querySelectorAll('.bili-subtitle-x-subtitle-panel-text'); return t.length ? Array.prototype.map.call(t,function(e){return (e.textContent||'').trim();}).filter(Boolean).join(' ') : ''; }
          var main = grp('.bili-subtitle-x-subtitle-panel-major-group');   // 主字幕
          if (main) return main;
          // 兜底（老结构/无分组）：取所有字幕文本
          var els = document.querySelectorAll('.bili-subtitle-x-subtitle-panel-text');
          if (els.length) return Array.prototype.map.call(els, function(e){ return (e.textContent||'').trim(); }).filter(Boolean).join(' ');
          var w = document.querySelector('.bpx-player-subtitle-wrap');
          return w ? (w.textContent||'').trim() : '';
        } catch(e){ return ''; }
      })(),
      subtitleSub: (function(){
        try {
          var g = document.querySelector('.bili-subtitle-x-subtitle-panel-minor-group');   // 副字幕（双语时才有）
          if (!g) return '';
          var t = g.querySelectorAll('.bili-subtitle-x-subtitle-panel-text');
          return t.length ? Array.prototype.map.call(t, function(e){ return (e.textContent||'').trim(); }).filter(Boolean).join(' ') : '';
        } catch(e){ return ''; }
      })(),
      social: (function(){
        function g(t){
          var e=document.querySelector('[title*="'+t+'"]');
          if(!e) return null;
          return { on: (' '+e.className.toString()+' ').indexOf(' on ')>=0, n:(e.textContent||'').trim().slice(0,8) };
        }
        return { like:g('点赞'), coin:g('投币'), fav:g('收藏') };
      })()
    };
  } catch (e) { return { error: String((e && e.message) || e) }; }
})()`;

/** 构造控制命令的页面表达式。 */
function cmdExpr(kind, arg) {
    const V = `var v=document.querySelector('video');`;
    switch (kind) {
        case 'play':
            return `(function(){${V} if(!v) return false; var p=v.play(); if(p&&p.catch)p.catch(function(){}); return true;})()`;
        case 'pause':
            return `(function(){${V} if(!v) return false; v.pause(); return true;})()`;
        case 'toggle':
            return `(function(){${V} if(!v) return false; if(v.paused){var p=v.play(); if(p&&p.catch)p.catch(function(){});} else {v.pause();} return !v.paused;})()`;
        case 'seekSeconds': // 绝对跳转到 arg 秒
            return `(function(){${V} if(!v) return -1; var s=Math.max(0, ${Number(arg) || 0}); if(isFinite(v.duration)) s=Math.min(s, v.duration); v.currentTime=s; return v.currentTime;})()`;
        case 'seekRatio':   // 跳转到 arg(0..1) * duration
            return `(function(){${V} if(!v||!isFinite(v.duration)) return -1; var r=Math.max(0,Math.min(1, ${Number(arg) || 0})); v.currentTime=r*v.duration; return v.currentTime;})()`;
        case 'skip':        // 相对快进/快退 arg 秒（可负）
            return `(function(){${V} if(!v) return -1; var d=isFinite(v.duration)?v.duration:1e9; v.currentTime=Math.max(0,Math.min(d, v.currentTime+(${Number(arg) || 0}))); return v.currentTime;})()`;
        case 'rate':        // 设定播放倍速
            return `(function(){${V} if(!v) return -1; v.playbackRate=${Number(arg) || 1}; return v.playbackRate;})()`;
        case 'next':        // 下一P / 下一集
            return `(function(){
                var sel=['[title*="下一P"]','[title*="下一集"]','[title*="下一话"]','.bpx-player-ctrl-next','[aria-label*="下一"]','[title*="下一"]'];
                for(var i=0;i<sel.length;i++){var b=document.querySelector(sel[i]); if(b){b.click(); return sel[i];}}
                return false;
            })()`;
        case 'volumeDelta':  // 相对调节视频音量（arg 为增量，正负皆可）
            return `(function(){${V} if(!v) return -1; var x=v.volume+(${Number(arg) || 0}); x=Math.max(0,Math.min(1,x)); v.volume=x; if(x>0&&v.muted)v.muted=false; return x;})()`;
        case 'volume':       // 绝对设定视频音量 0..1
            return `(function(){${V} if(!v) return -1; var x=Math.max(0,Math.min(1,${Number(arg) || 0})); v.volume=x; if(x>0&&v.muted)v.muted=false; return x;})()`;
        case 'mute':         // 静音切换
            return `(function(){${V} if(!v) return -1; v.muted=!v.muted; return v.muted;})()`;
        case 'danmaku':      // 弹幕显示/隐藏 切换
            return `(function(){var i=document.querySelector('.bui-danmaku-switch-input,.bpx-player-dm-switch-input'); if(i){i.click(); return !!i.checked;} return null;})()`;
        case 'fullscreen':   // 全屏 打开/关闭 切换（点击播放器全屏按钮，需 userGesture）
            return `(function(){var b=document.querySelector('.bpx-player-ctrl-full,[aria-label="全屏"],[aria-label="退出全屏"]'); if(b){b.click(); return null;} return null;})()`;
        case 'like':        // 点赞（再次点击取消）
            return `(function(){var b=document.querySelector('[title*="点赞"]'); if(b){b.click(); return true;} return false;})()`;
        case 'coin':        // 投币（按 B 站设置，可能弹确认框；开启「不再询问」即一键投币）
            return `(function(){var b=document.querySelector('[title*="投币"]'); if(b){b.click(); return true;} return false;})()`;
        case 'favorite':    // 收藏（点击打开收藏夹选择）
            return `(function(){var b=document.querySelector('[title*="收藏"]'); if(b){b.click(); return true;} return false;})()`;
        default:
            return `(function(){return null;})()`;
    }
}

/** 从 player.html 的 url 中解析 bvid（UGC 稿件）。 */
function bvidFromHref(href) {
    if (!href) return null;
    const m = href.match(/[?&]bvid=(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
}

// ---- 接口：按 bvid 拉取元数据 ---------------------------------------------

function httpsGet(url, { headers = {}, binary = false, timeout = 6000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                'Referer': 'https://www.bilibili.com',
                ...headers,
            },
            timeout,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpsGet(res.headers.location, { headers, binary, timeout }));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve(binary ? buf : buf.toString('utf8'));
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
    });
}

/**
 * 拉取视频元数据：标题 / UP主 / 封面(base64) / 时长。
 * 失败时抛出，调用方需兜底（用 docTitle）。
 */
async function fetchVideoMeta(bvid) {
    const txt = await httpsGet(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const json = JSON.parse(txt);
    if (json.code !== 0 || !json.data) throw new Error('view 接口返回 code=' + json.code);
    const d = json.data;
    const meta = {
        bvid,
        title: d.title || '',
        up: (d.owner && d.owner.name) || '',
        durationSec: d.duration || 0,
        coverUrl: d.pic || '',
        coverBase64: null,
    };
    if (meta.coverUrl) {
        try {
            // 取较小尺寸封面，省带宽（B 站图片支持 @ 参数缩放）
            const url = meta.coverUrl.replace(/^http:/, 'https:') + '@480w_300h_1c.jpg';
            const img = await httpsGet(url, { binary: true });
            meta.coverBase64 = img.toString('base64');
        } catch { /* 封面失败可忽略 */ }
    }
    return meta;
}

module.exports = { STATE_EXPR, cmdExpr, bvidFromHref, fetchVideoMeta };
