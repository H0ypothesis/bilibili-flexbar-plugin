#!/usr/bin/env node
'use strict';
/**
 * 不依赖 flexcli 的本地安装：把已构建的插件目录复制到 FlexDesigner 的插件目录。
 *   com.eniac.bilibiliplugin.plugin/  →  ~/Library/Application Support/FlexDesigner/data/plugins/com.eniac.bilibiliplugin/
 * 复制后需重启 FlexDesigner 以加载。适合 flexcli 因 Node 版本无法运行时使用。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID = 'com.eniac.bilibiliplugin';
const SRC = path.join(__dirname, '..', `${UUID}.plugin`);
const DST = path.join(os.homedir(), 'Library', 'Application Support', 'FlexDesigner', 'data', 'plugins', UUID);

if (!fs.existsSync(path.join(SRC, 'backend', 'plugin.cjs'))) {
    console.error('未找到 backend/plugin.cjs，请先运行: npm run build');
    process.exit(1);
}
if (!fs.existsSync(path.dirname(DST))) {
    console.error('未找到 FlexDesigner 插件目录: ' + path.dirname(DST));
    console.error('请确认已安装并至少运行过一次 FlexDesigner。');
    process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, {
    recursive: true,
    filter: (s) => !s.split(path.sep).includes('logs'),  // 不复制运行期日志
});

console.log('已安装到: ' + DST);
console.log('请重启 FlexDesigner（或重新打开），即可在 Key Library 中看到「哔哩哔哩」。');
