/**
 * Canvas Renderer — 哔哩哔哩「正在播放」
 * 使用 @napi-rs/canvas 渲染视频标题 / UP主 / 封面 / 进度。
 */

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// 注册系统字体以支持中日韩文字
function registerSystemFonts(logger) {
    const platform = process.platform;
    const fontPaths = [];

    if (platform === 'win32') {
        const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
        fontPaths.push(
            { path: path.join(winFonts, 'msyh.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'msyhbd.ttc'), family: 'Microsoft YaHei' },
            { path: path.join(winFonts, 'simhei.ttf'), family: 'SimHei' }
        );
    } else if (platform === 'darwin') {
        fontPaths.push(
            { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
            { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' },
            { path: '/Library/Fonts/Arial Unicode.ttf', family: 'Arial Unicode MS' }
        );
    } else {
        fontPaths.push(
            { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK' }
        );
    }

    let registered = false;
    for (const font of fontPaths) {
        try {
            if (fs.existsSync(font.path)) {
                GlobalFonts.registerFromPath(font.path, font.family);
                registered = true;
            }
        } catch (err) { /* 忽略字体注册错误 */ }
    }
    if (!registered && logger) logger.warn('[CanvasRenderer] 未注册 CJK 字体，部分字符可能无法显示');
}

// 哔哩哔哩配色
const COLORS = {
    background: '#18191C',
    cardBg: '#2A2B30',
    primary: '#FFFFFF',
    secondary: '#9499A0',
    accent: '#FB7299',        // 哔哩哔哩粉
    accent2: '#00AEEC',       // 哔哩哔哩蓝
    progressBg: '#3A3B3D',
    progressFill: '#FB7299'
};

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 60;
const FONT_FAMILY = 'Microsoft YaHei, PingFang SC, Hiragino Sans GB, SimHei, Noto Sans CJK, Arial, sans-serif';

class CanvasRenderer {
    constructor(logger) {
        this.logger = logger;
        this.fontsRegistered = false;
    }

    ensureFonts() {
        if (!this.fontsRegistered) {
            registerSystemFonts(this.logger);
            this.fontsRegistered = true;
        }
    }

    formatTime(ms) {
        if (!ms || ms < 0) return '0:00';
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    truncateText(ctx, text, maxWidth) {
        if (!text) return '';
        let truncated = text;
        let width = ctx.measureText(truncated).width;
        if (width <= maxWidth) return truncated;
        while (width > maxWidth && truncated.length > 0) {
            truncated = truncated.slice(0, -1);
            width = ctx.measureText(truncated + '…').width;
        }
        return truncated + '…';
    }

    async loadCover(coverBase64, size) {
        if (!coverBase64) return this.createDefaultCover(size);
        try {
            let data = coverBase64;
            if (!coverBase64.startsWith('data:')) data = `data:image/jpeg;base64,${coverBase64}`;
            return await loadImage(data);
        } catch (err) {
            if (this.logger) this.logger.error(`[CanvasRenderer] 加载封面失败: ${err.message}`);
            return this.createDefaultCover(size);
        }
    }

    // 默认封面：哔哩哔哩粉底 + 电视/播放标记
    createDefaultCover(size) {
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = COLORS.accent;
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${Math.floor(size * 0.42)}px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('▶', size / 2, size / 2 + 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        return canvas;
    }

    /**
     * 渲染正在播放组件
     * @param {object} state - { video:{title,up,coverBase64}, playState, timeline:{currentTime,totalTime} }
     * @param {object} options - { showTitle, showUp, showCover, showProgress }
     */
    async render(state, options = {}, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
        this.ensureFonts();
        const {
            showTitle = true,
            showUp = true,
            showCover = true,
            showProgress = true
        } = options;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // 背景
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, width, height);

        const video = state.video;
        if (!video || !video.title) {
            return this.renderIdleState(canvas, ctx, width, height);
        }

        const isPlaying = state.playState === 'Playing';
        const progressMs = state.timeline?.currentTime || 0;
        const durationMs = state.timeline?.totalTime || 0;

        // 封面（左侧方形）
        const coverSize = height;
        let textX = 10;
        if (showCover) {
            try {
                const cover = await this.loadCover(video.coverBase64, coverSize);
                // 视频封面是 16:9，这里裁成方形居中
                const ar = (cover.width && cover.height) ? cover.width / cover.height : 1;
                let sw = cover.width, sh = cover.height, sx = 0, sy = 0;
                if (ar > 1) { sw = cover.height; sx = (cover.width - sw) / 2; }
                else if (ar < 1) { sh = cover.width; sy = (cover.height - sh) / 2; }
                ctx.drawImage(cover, sx, sy, sw, sh, 0, 0, coverSize, coverSize);
            } catch (err) {
                if (this.logger) this.logger.error(`[CanvasRenderer] 绘制封面错误: ${err.message}`);
            }
            textX = coverSize + 12;
        }

        const textPadding = 10;
        const textMaxWidth = width - textX - textPadding;
        const progressHeight = 4;
        const progressY = height - progressHeight;

        // 标题（左上）
        if (showTitle && video.title) {
            ctx.fillStyle = COLORS.primary;
            ctx.font = `bold 18px ${FONT_FAMILY}`;
            ctx.fillText(this.truncateText(ctx, video.title, textMaxWidth), textX, 22);
        }

        // UP主（标题下方，前缀小图标色块）
        if (showUp && video.up) {
            const upY = 42;
            ctx.font = `14px ${FONT_FAMILY}`;
            // UP 角标
            ctx.fillStyle = COLORS.accent;
            const tagW = ctx.measureText('UP').width + 8;
            ctx.fillRect(textX, upY - 12, tagW, 16);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText('UP', textX + 4, upY + 1);
            // 名称
            ctx.fillStyle = COLORS.secondary;
            ctx.fillText(this.truncateText(ctx, video.up, textMaxWidth - tagW - 8), textX + tagW + 6, upY + 1);
        }

        // 进度条 + 时间
        if (showProgress && durationMs > 0) {
            const progress = Math.min(progressMs / durationMs, 1);
            const barX = showCover ? coverSize : 0;
            const barW = width - barX;

            // 时间标签（右下）
            ctx.fillStyle = COLORS.secondary;
            ctx.font = `11px ${FONT_FAMILY}`;
            ctx.textAlign = 'right';
            ctx.fillText(`${this.formatTime(progressMs)} / ${this.formatTime(durationMs)}`, width - textPadding, progressY - 4);
            ctx.textAlign = 'left';

            // 进度条
            ctx.fillStyle = COLORS.progressBg;
            ctx.fillRect(barX, progressY, barW, progressHeight);
            if (progress > 0) {
                ctx.fillStyle = COLORS.progressFill;
                ctx.fillRect(barX, progressY, barW * progress, progressHeight);
            }
        }

        // 暂停时在封面上叠加暂停标记
        if (showCover && !isPlaying) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(0, 0, coverSize, coverSize);
            ctx.fillStyle = COLORS.primary;
            const ih = Math.floor(coverSize * 0.4);
            const iw = Math.floor(ih * 0.25);
            const gap = Math.floor(iw * 0.8);
            const ix = (coverSize - iw * 2 - gap) / 2;
            const iy = (coverSize - ih) / 2;
            ctx.fillRect(ix, iy, iw, ih);
            ctx.fillRect(ix + iw + gap, iy, iw, ih);
        }

        return canvas.toBuffer('image/png');
    }

    /**
     * 渲染字幕键。主字幕(main)用粉色、较大；副字幕(sub)用白色、较小。
     * - 双语(main+sub)：主粉色在上、副白色在下，各自单行自适应缩放（超长省略）。
     * - 单语(仅 main)：粉色，单行放不下则折两行。
     * - 皆空：暗色「字幕」占位。
     */
    async renderSubtitle(main, sub, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
        this.ensureFonts();
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, width, height);

        const pad = 14;
        const maxWidth = width - pad * 2;
        const cx = width / 2, cy = height / 2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const m = (main || '').trim();
        const s = (sub || '').trim();

        if (!m && !s) {
            ctx.fillStyle = COLORS.secondary;
            ctx.font = `${Math.floor(height * 0.3)}px ${FONT_FAMILY}`;
            ctx.fillText('字幕', cx, cy);
            ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
            return canvas.toBuffer('image/png');
        }

        // 单行自适应：字号从 startFont 往下缩到放得下；到 minFont 仍超则截断加省略号。
        const fitOneLine = (text, startFont, minFont, weight) => {
            let f = startFont, out = text;
            for (; f >= minFont; f--) {
                ctx.font = `${weight} ${f}px ${FONT_FAMILY}`;
                if (ctx.measureText(text).width <= maxWidth) break;
            }
            if (f < minFont) { f = minFont; ctx.font = `${weight} ${f}px ${FONT_FAMILY}`; out = this.truncateText(ctx, text, maxWidth); }
            return { font: f, text: out };
        };

        if (m && s) {
            // 双语：主(粉,大)在上，副(白,小)在下
            const mainFit = fitOneLine(m, Math.floor(height * 0.40), 15, 'bold');    // ≈24 @60
            const subFit  = fitOneLine(s, Math.floor(height * 0.27), 12, 'normal');  // ≈16 @60
            const gap = 4;
            const totalH = mainFit.font + gap + subFit.font;
            const top = (height - totalH) / 2;
            ctx.fillStyle = COLORS.accent;                 // 主字幕：哔哩哔哩粉
            ctx.font = `bold ${mainFit.font}px ${FONT_FAMILY}`;
            ctx.fillText(mainFit.text, cx, top + mainFit.font / 2);
            ctx.fillStyle = COLORS.primary;                // 副字幕：白
            ctx.font = `normal ${subFit.font}px ${FONT_FAMILY}`;
            ctx.fillText(subFit.text, cx, top + mainFit.font + gap + subFit.font / 2);
        } else {
            // 单语（仅主字幕）：粉色；单行放不下折两行
            const t = m || s;
            ctx.fillStyle = COLORS.accent;
            const maxFont = Math.floor(height * 0.46), minFont = 15;
            let font = maxFont;
            for (; font >= minFont; font--) { ctx.font = `bold ${font}px ${FONT_FAMILY}`; if (ctx.measureText(t).width <= maxWidth) break; }
            if (font >= minFont) {
                ctx.font = `bold ${font}px ${FONT_FAMILY}`;
                ctx.fillText(t, cx, cy);
            } else {
                font = Math.floor(height * 0.3);
                ctx.font = `bold ${font}px ${FONT_FAMILY}`;
                const lines = this.wrapTwoLines(ctx, t, maxWidth);
                const lineH = font * 1.15;
                const startY = cy - (lineH * (lines.length - 1)) / 2;
                lines.forEach((ln, i) => ctx.fillText(ln, cx, startY + i * lineH));
            }
        }

        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        return canvas.toBuffer('image/png');
    }

    // 按宽度把文本折成最多两行（CJK 无空格，按字符累积；第二行超长加省略号）
    wrapTwoLines(ctx, text, maxWidth) {
        let line1 = '', i = 0;
        for (; i < text.length; i++) {
            if (ctx.measureText(line1 + text[i]).width > maxWidth && line1) break;
            line1 += text[i];
        }
        let line2 = text.slice(i);
        if (!line2) return [line1];
        if (ctx.measureText(line2).width > maxWidth) {
            while (line2.length && ctx.measureText(line2 + '…').width > maxWidth) line2 = line2.slice(0, -1);
            line2 += '…';
        }
        return [line1, line2];
    }

    renderIdleState(canvas, ctx, width, height) {
        const cx = width / 2, cy = height / 2;
        ctx.fillStyle = COLORS.accent;
        ctx.font = `${Math.floor(height * 0.4)}px ${FONT_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('▶', cx - 70, cy);
        ctx.fillStyle = COLORS.secondary;
        ctx.font = `${Math.floor(height * 0.3)}px ${FONT_FAMILY}`;
        ctx.fillText('未在播放', cx + 30, cy);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        return canvas.toBuffer('image/png');
    }
}

module.exports = CanvasRenderer;
