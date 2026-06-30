# macOS 哔哩哔哩桥接服务 (Bilibili macOS Bridge)

让 FlexBar 的 **BilibiliPlugin** 能读取并控制哔哩哔哩 Mac 客户端的视频播放。

## 背景

FlexBar 插件本身只是一个 WebSocket **客户端**，连接 `ws://127.0.0.1:35020`，等待“服务端”
推送播放状态、接收控制命令。本服务就是这个服务端。

哔哩哔哩 Mac 客户端是 **Electron 应用**，并不向系统「正在播放」上报，因此不能像音乐类
App 那样走 MediaRemote。取而代之，本服务用 `--remote-debugging-port` 启动它，通过
**Chrome DevTools Protocol** 直接驱动其内嵌网页播放器 `player.html` 里的 `<video>`：

```
哔哩哔哩.app (Electron, --remote-debugging-port=9222)
     │  CDP（player.html 的 <video>）
     ▼
   本服务  ──►  currentTime / duration / paused、标题/UP/封面
     │      ◄──  Play / Pause / Seek / 下一集 …
     ▼  ws://127.0.0.1:35020
 FlexBar 插件
```

## 使用

```bash
# 在项目根目录
npm install            # 首次
npm run macos:bridge   # = bash macos-bridge/start.sh
```

`start.sh` 会：
1. 确保依赖已安装；
2. 确保哔哩哔哩以调试端口运行——若它正运行但没开端口，会**退出并重启**它；
3. 启动 node 桥接服务，监听 `ws://127.0.0.1:35020`。

看到 `WebSocket 服务已启动: ws://127.0.0.1:35020` 即就绪。然后在哔哩哔哩里播放视频、
把插件按键放到 FlexBar 上即可。

### 常驻 / 开机自启

```bash
bash macos-bridge/install-launchagent.sh
bash macos-bridge/uninstall-launchagent.sh
```

## 协议（服务端 → 插件 / 插件 → 服务端）

服务端推送：`FullState` / `VideoUpdate` / `PlayStateUpdate` / `TimelineUpdate`
插件命令：`GetState` `Play` `Pause` `TogglePlay` `Seek{positionMs}` `SeekRatio{ratio}`
`SkipForward{seconds}` `SkipBackward{seconds}` `NextEpisode` `PreviousEpisode` `SetRate{rate}`

## 配置（环境变量）

见项目根 `README.md`。常用：`BILIBILI_WS_PORT`(35020)、`BILIBILI_CDP_PORT`(9222)、
`BILIBILI_APP`(哔哩哔哩)、`BILIBILI_POLL_MS`(300)、`DEBUG`。

## 文件

```
macos-bridge/
  cdp.js        极简 CDP 客户端（解析目标页 + WebSocket + Runtime.evaluate）
  bilibili.js   页面内表达式（读状态/发命令）+ 按 bvid 拉取元数据
  server.js     桥接主程序（CDP 轮询 + 面向插件的 WS 服务 + App 启动管理）
  start.sh      启动脚本（确保调试端口 + 拉起服务）
  install-launchagent.sh / uninstall-launchagent.sh
```

## 注意

- 仅 macOS。需已安装 `/Applications/哔哩哔哩.app`。
- 「下一集/上一集」点击的是播放器「下一P/上一P」按钮，单P视频可能无动作。
- 远程调试端口仅监听 `127.0.0.1`，不对外暴露。
