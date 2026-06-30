#!/usr/bin/env node
'use strict';
/**
 * 生成哔哩哔哩风格的插件图标（粉底白色电视）并写入：
 *   - com.h0ypothesis.bilibili.plugin/resources/Bilibili.png
 *   - 替换 manifest.json 中 keyLibrary.style.icon 的 data URI
 */
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const SIZE = 324;
const PLUGIN_DIR = path.join(__dirname, '..', 'com.h0ypothesis.bilibili.plugin');

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function render() {
    const c = createCanvas(SIZE, SIZE);
    const ctx = c.getContext('2d');
    const S = SIZE;

    // 粉色圆角底
    ctx.fillStyle = '#FB7299';
    roundRect(ctx, 0, 0, S, S, S * 0.22);
    ctx.fill();

    // 天线（两条白色斜线 + 圆头）
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineCap = 'round';
    ctx.lineWidth = S * 0.05;
    const tvX = S * 0.2, tvY = S * 0.36, tvW = S * 0.6, tvH = S * 0.42;
    // 左天线
    ctx.beginPath();
    ctx.moveTo(tvX + tvW * 0.18, tvY);
    ctx.lineTo(S * 0.3, S * 0.16);
    ctx.stroke();
    // 右天线
    ctx.beginPath();
    ctx.moveTo(tvX + tvW * 0.82, tvY);
    ctx.lineTo(S * 0.7, S * 0.16);
    ctx.stroke();

    // 电视机身（白色圆角矩形）
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, tvX, tvY, tvW, tvH, S * 0.07);
    ctx.fill();

    // 屏幕里：两只「眼睛」+ 居中播放三角
    ctx.fillStyle = '#FB7299';
    const eyeR = S * 0.026;
    const eyeY = tvY + tvH * 0.32;
    // 眼睛（小斜杠更像 logo，这里用圆点简化）
    ctx.beginPath(); ctx.arc(tvX + tvW * 0.28, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(tvX + tvW * 0.72, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    // 播放三角
    const cx = tvX + tvW / 2, cy = tvY + tvH * 0.62, tr = S * 0.06;
    ctx.beginPath();
    ctx.moveTo(cx - tr * 0.6, cy - tr);
    ctx.lineTo(cx - tr * 0.6, cy + tr);
    ctx.lineTo(cx + tr, cy);
    ctx.closePath();
    ctx.fill();

    return c.toBuffer('image/png');
}

function main() {
    const buf = render();
    const resDir = path.join(PLUGIN_DIR, 'resources');
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(resDir, 'Bilibili.png'), buf);

    const dataUri = 'data:image/png;base64,' + buf.toString('base64');
    const manifestPath = path.join(PLUGIN_DIR, 'manifest.json');
    let text = fs.readFileSync(manifestPath, 'utf8');
    // 仅替换 keyLibrary.style.icon（第一个 data:image png 图标）
    text = text.replace(/("icon":\s*")data:image\/png;base64,[^"]*(")/, `$1${dataUri}$2`);
    fs.writeFileSync(manifestPath, text);

    console.log(`图标已生成: ${path.relative(process.cwd(), path.join(resDir, 'Bilibili.png'))} (${buf.length} 字节)`);
    console.log('已写入 manifest.json keyLibrary.style.icon');
}

main();
