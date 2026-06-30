# BilibiliPlugin — FlexBar 哔哩哔哩控制插件 (macOS)

在 FlexBar 上显示哔哩哔哩**正在播放**的视频（封面 / 标题 / UP主 / 进度），并直接控制
**进度条拖拽、播放/暂停、下一集、快进快退、音量、弹幕、点赞/投币/收藏**。

<p align="center">
  <img src="com.h0ypothesis.bilibili.plugin/resources/Bilibili.png" width="96" alt="Bilibili Plugin" />
</p>

## 工作原理

哔哩哔哩 Mac 客户端（`/Applications/哔哩哔哩.app`，bundle `com.bilibili.bilibiliPC`）是一个
**Electron 应用**。用 `--remote-debugging-port` 启动后，它会暴露 Chrome DevTools Protocol(CDP)，
其中 `player.html` 页面承载真正的 `<video>` 元素。本插件据此实现控制：

```
哔哩哔哩.app (Electron, --remote-debugging-port=9222)
     │  CDP：读取/驱动 player.html 里的 <video>
     ▼
 macos-bridge (Node 服务)  ──►  currentTime / duration / paused、标题/UP/封面
     │                      ◄──  Play / Pause / Seek / 下一集 …
     ▼  ws://127.0.0.1:35020
 FlexBar 插件 (backend/plugin.cjs)  ──►  FlexBar 按键
```

- **进度条拖拽** = 设置 `video.currentTime`（逐帧精确）
- **播放 / 暂停** = `video.play()` / `video.pause()`（读真实状态）
- **下一集** = 点击播放器「下一P」按钮
- **快进 / 快退** = `video.currentTime ± 15s`
- **音量** = 设置 `video.volume`（播放器内音量，非系统音量）
- **弹幕 / 点赞 / 投币 / 收藏** = 点击播放器里对应按钮
- **标题 / UP主 / 封面** = 按 `bvid` 调哔哩哔哩 `view` 接口获取（稳定、含封面）

> 插件本身只是一个 WebSocket 客户端（和姊妹项目 NeteasePlugin 一样的结构）；真正干活的是
> `macos-bridge/`。两者解耦，便于调试与常驻。

## 功能

| 功能 | 状态 |
| --- | --- |
| 视频标题 / UP主 / 封面 / 进度显示 | ✅ |
| 进度条**拖拽跳转**（slider 按键） | ✅ 逐帧精确 |
| 播放 / 暂停（multiState 按键） | ✅ 真实状态同步 |
| 下一集（多P / 分集） | ✅ 点击播放器按钮，单P视频可能无动作 |
| 快进 / 快退 15 秒 | ✅ |
| 进度旋钮 / 音量旋钮（wheel 按键） | ✅ 音量为播放器内音量 |
| 弹幕显示 / 隐藏 | ✅ |
| 点赞 / 投币 / 收藏 | ✅ 状态高亮；投币/收藏按 B 站设置 |
| 触感反馈（haptic） | ✅ 离散操作时 |

## 环境要求

- macOS 11+（已在 Apple Silicon / macOS 实测）
- 已安装哔哩哔哩 Mac 客户端 `/Applications/哔哩哔哩.app`
- Node.js（见下方 ⚠️ 版本说明）
- FlexDesigner 1.0+ 与一台 FlexBar

> ⚠️ **Node 版本**：`flexcli`（FlexDesigner 的命令行）目前使用了 `import ... assert { type: 'json' }`
> 旧语法，**在 Node 23+ 会报 `Unexpected identifier 'assert'`**。运行 `flexcli` / `npm run dev`
> 等命令请切到 **Node 20 LTS**（推荐用 nvm：`nvm install 20 && nvm use 20`）。
> 桥接服务 `macos-bridge` 与构建本身在新版 Node 上正常。

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2) 生成图标 + 构建插件后端
npm run gen:icon
npm run build

# 3) 启动桥接服务（会自动以调试端口启动/重启哔哩哔哩）
npm run macos:bridge
#   看到 “WebSocket 服务已启动: ws://127.0.0.1:35020” 即就绪

# 4) 在 FlexDesigner 里加载插件（需 Node 20，见上方说明）
nvm use 20
npm run dev          # 链接并热重载；插件会出现在 Key Library
```

然后在哔哩哔哩里播放任意视频，把插件按键拖到 FlexBar 上即可使用。

### 让桥接服务常驻 / 开机自启

```bash
bash macos-bridge/install-launchagent.sh     # 登录自动启动、崩溃自动重启
bash macos-bridge/uninstall-launchagent.sh   # 撤销
```

## 按键说明

| 按键 | 类型 | 作用 |
| --- | --- | --- |
| 正在播放 | default | 封面 / 标题 / UP主 / 进度（可在配置里增减显示项）|
| 进度条 | **slider** | 拖动跳转到任意位置 |
| 播放/暂停 | **multiState** | 切换播放状态，图标随状态变化 |
| 下一集 | default | 下一P / 下一集（多P或分集）|
| 快退15秒 / 快进15秒 | default | 相对快退 / 快进 |
| 进度旋钮 | **wheel** | 旋转微调进度（每格约 2 秒）|
| 音量旋钮 | **wheel** | 旋转调节**视频内**音量（非系统音量）|
| 弹幕 | **multiState** | 显示 / 隐藏弹幕，开启时高亮 |
| 点赞 | **multiState** | 点赞/取消，已赞时高亮（粉色）|
| 投币 | **multiState** | 投币，已投时高亮；视 B 站设置可能弹确认框 |
| 收藏 | **multiState** | 收藏，已收藏时高亮；点击打开收藏夹选择 |

> 点赞/投币/收藏 通过点击播放器里对应按钮实现（和「下一集」同理）。点赞可直接切换;
> 投币、收藏会按 B 站客户端的设置走——在 B 站里开启「投币后不再询问」即可一键投币。

## 配置页（FlexDesigner 内）

三步向导：
1. **启动桥接服务** —— 复制 `npm run macos:bridge` 去终端运行（或装 launchagent）。
2. **以调试模式运行哔哩哔哩** —— 一键退出并带调试端口重启它。
3. **测试连接** —— 播放任意视频后点测试。

## 常见问题

- **连不上 / 一直“未在播放”**
  - 确认 `macos-bridge` 在运行（`npm run macos:bridge`）。
  - 确认哔哩哔哩以调试端口启动：`curl http://127.0.0.1:9222/json/version` 应有返回；
    否则在配置页点「一键重启哔哩哔哩（调试模式）」，或先**完全退出**哔哩哔哩再运行 `start.sh`。
  - 进度/状态来自正在播放的 `<video>`，请确保确实在播放视频页面。
- **`flexcli` 报 `Unexpected identifier 'assert'`** —— Node 版本太新，切到 Node 20（见上）。
- **下一集没反应** —— 单P视频本就没有「下一P」；多P/分集视频可用。
- **封面不显示** —— 偶发接口/网络问题；其余功能不受影响，会回退为粉色占位封面。

## 环境变量（桥接服务）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BILIBILI_WS_PORT` | `35020` | 插件连接端口（需与插件一致）|
| `BILIBILI_CDP_PORT` | `9222` | 哔哩哔哩远程调试端口 |
| `BILIBILI_APP` | `哔哩哔哩` | App 名称（用于启动）|
| `BILIBILI_POLL_MS` | `300` | 状态轮询间隔（毫秒）|
| `BILIBILI_NO_AUTOLAUNCH` | 未设置 | 设为任意值则不自动启动 App |
| `DEBUG` | 未设置 | 打印调试日志 |

## 目录结构

```
bilibili/
├── src/                         # 插件后端源码（rollup 打包）
│   ├── plugin.js                #   WS 客户端 + 按键逻辑（slider/wheel/multiState）
│   └── canvas-renderer.js       #   正在播放卡片绘制
├── com.h0ypothesis.bilibili.plugin/
│   ├── manifest.json            #   按键定义 / i18n / 主题
│   ├── config.json
│   ├── resources/Bilibili.png   #   图标（由 scripts/gen-icon.js 生成）
│   ├── ui/configPage.vue        #   配置向导
│   ├── ui/nowplaying.vue        #   正在播放按键配置
│   └── backend/plugin.cjs       #   构建产物
├── macos-bridge/                # CDP 桥接服务（见其 README）
├── scripts/gen-icon.js          # 生成图标并写入 manifest
├── rollup.config.mjs
└── package.json
```

## 致谢

- 结构参考姊妹项目 NeteasePlugin / [ENIAC-Tech/NeteasePlugin](https://github.com/ENIAC-Tech/NeteasePlugin)
- FlexDesigner SDK — ENIAC
