# whale-girl-desktop

[English](README.en.md) | **中文**

一个 DeepSeek Harness 的桌面伴侣宠物——鲸鱼娘浮在你的屏幕上,实时跟随 DSH 会话状态:思考、等待、庆祝、打盹,头顶还有当前运行会话的气泡。

## 需要什么(三件套,按顺序)

```
① DeepSeek Harness (dsh web)          运行环境
② whale-girl 插件(带 sessions 端点)    提供 /whale-girl/state · /presence · /assets/* · /sessions
③ 本桌面壳                             置顶悬浮宠物窗口
```

- **whale-girl 插件**:安装官方源即可——外部消费者 API(PR #1)与每会话端点(PR #5)均已合入 vlln main:

  ```sh
  dsh plugin --profile web add github:vlln/whale-girl
  ```

  装完重启 `dsh web`,然后验证:
  `curl http://127.0.0.1:3080/whale-girl/sessions` 能返回会话列表。

- **Node.js**(>= 22)和 **Electron**。

## 安装与运行

```sh
npm install          # 安装 Electron
npm start
# 或:.\node_modules\.bin\electron.cmd .
```

> **Electron 二进制下载卡住?** 网络直连 GitHub release 不稳时,用 npmmirror 镜像:
>
> ```sh
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> node node_modules\electron\install.js
> ```

宠物悬浮在右下角、始终置顶:

- **单击** 切换内嵌的 DSH 网页窗口(`http://127.0.0.1:3080`)——是第二个隐藏窗口,绝不停服务。
- **右键** 打开尺寸菜单:75 / 100 / 125 / 150 / 200%(持久化)。
- **拖拽** 移动(位置会记住)。
- 宠物上方,**每个运行中的会话**一个消息气泡:标题 + 当前动作(深度思考中 / 运行命令行中 / 执行工具 / 等待批准);会话结束气泡消失。
- 在线期间每 15s 心跳 `POST /whale-girl/presence`,网页宠物自动隐藏(不双宠);退出时网页宠物即刻恢复。

## 开发 / 调试

```sh
.\node_modules\.bin\electron.cmd . --screenshot=pet.png            # 5 秒后截图并退出
.\node_modules\.bin\electron.cmd . --screenshot=pet.png --screenshot-delay=70000  # 打盹测试
.\node_modules\.bin\electron.cmd . --sleep-after=8000              # 缩短空闲→打盹阈值(测试用)
.\node_modules\.bin\electron.cmd . --web-shot=web.png              # 截内嵌网页窗口
.\node_modules\.bin\electron.cmd . --base-url=http://127.0.0.1:3999  # 轮询 mock DSH(tests/mock-dsh.cjs)
.\node_modules\.bin\electron.cmd . --dev                           # 转发渲染器控制台
```

## 目录结构

```
main.cjs        Electron 主进程:窗口、state+sessions 轮询、心跳、尺寸预设、点击切换网页窗口、手动拖拽
preload.cjs     暴露 window.pet(onState / onManifest / onScale / onSessions / toggleWeb / openMenu / dragStart / dragMove / dragEnd)
renderer/       index.html + renderer.js:精灵动画驱动 + 会话气泡
tests/          mock-dsh.cjs —— 确定性 mock DSH 服务器(免凭据截图验证用)
```

## 实现说明

- 渲染器是 `file://` 页面;所有 DSH API 调用走主进程(Node fetch 无 CORS),快照/清单/缩放/会话列表经 IPC 下发。精灵图从 `http://127.0.0.1:3080/whale-girl/assets/characters/<角色>/<sheet>` 加载。
- `contextIsolation` 关闭,以便 preload 直接挂 `window.pet`(contextBridge 回调跨隔离世界会静默失效)。应用只加载本地文件、只访问环回 DSH。
- 窗口用手动拖拽 IPC 代替 `-webkit-app-region: drag`(拖拽区会吞掉点击);按下后移动 <5px 判定为单击。

## 署名

- 基于 whale-girl 插件生态:[vlln/whale-girl](https://github.com/vlln/whale-girl) 的外部消费者 API 契约(MIT,© Sam Gao (vlln));每会话端点在 [xiaoshihou514/whale-girl](https://github.com/xiaoshihou514/whale-girl)(`codex/external-state-api`)。
- 角色「鲸鱼娘」:原作 [上善](https://www.pixiv.net/users/62155430),二创设计 [ZipZipPipe](https://space.bilibili.com/4168597)。精灵素材运行时从 whale-girl 插件加载,**本仓库不含任何角色美术**。

## 许可证

MIT,见 [LICENSE](LICENSE)。角色美术归其作者按 whale-girl 项目声明授权;本壳不重新分发。
