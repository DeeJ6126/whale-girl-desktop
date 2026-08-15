# whale-girl-desktop

[中文](README.md) | **English**

A desktop companion pet for DeepSeek Harness — the whale-girl (鲸鱼娘) floating
on your screen, reacting to your DSH sessions: thinking, waiting, celebrating,
sleeping, with a live session bubble above her.

## What you need (three pieces, in order)

```
① DeepSeek Harness (dsh web)          the runtime
② whale-girl plugin (with sessions)   provides /whale-girl/state · /presence · /assets/* · /sessions
③ this desktop shell                  the always-on-top pet window
```

- **whale-girl plugin**: install the version that exposes `/whale-girl/sessions`
  (the per-session endpoint this pet's bubbles depend on):

  ```sh
  dsh plugin --profile web add github:xiaoshihou514/whale-girl#codex/external-state-api
  # after the upstream sessions PR merges, switch to the official source:
  # dsh plugin --profile web add github:vlln/whale-girl
  ```

  Restart `dsh web` after installing, then verify:
  `curl http://127.0.0.1:3080/whale-girl/sessions` returns session rows.

- **Node.js** (>= 22) and **Electron**.

## Install & run

```sh
npm install          # installs Electron
npm start
# or: .\node_modules\.bin\electron.cmd .
```

> **Electron binary download stalls?** On networks where the default GitHub
> release download hangs, use the npmmirror mirror:
>
> ```sh
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> node node_modules\electron\install.js
> ```

The pet floats bottom-right, always on top:

- **Click** toggles the embedded DSH web window (`http://127.0.0.1:3080`) — a
  second hidden window, never the service itself.
- **Right-click** opens the size menu: 75 / 100 / 125 / 150 / 200% (persisted).
- **Drag** to move it (position remembered).
- Above the pet, one message bubble per **running** session: title + current
  action (深度思考中 / 运行命令行中 / 执行工具 / 等待批准); a finished
  session's bubble disappears.
- While online it heartbeats `POST /whale-girl/presence` every 15s, so the
  in-page web pet hides itself (no double pets); on quit the web pet returns.

## Development / debug

```sh
.\node_modules\.bin\electron.cmd . --screenshot=pet.png            # capture after 5s and quit
.\node_modules\.bin\electron.cmd . --screenshot=pet.png --screenshot-delay=70000  # sleep test
.\node_modules\.bin\electron.cmd . --sleep-after=8000              # shorten idle→sleep for tests
.\node_modules\.bin\electron.cmd . --web-shot=web.png              # capture the embedded web window
.\node_modules\.bin\electron.cmd . --base-url=http://127.0.0.1:3999  # poll a mock DSH (tests/mock-dsh.cjs)
.\node_modules\.bin\electron.cmd . --dev                           # forward renderer console
```

## Layout

```
main.cjs        Electron main: windows, state+sessions poll, presence heartbeat,
                size presets, click-to-toggle web window, manual drag
preload.cjs     exposes window.pet (onState / onManifest / onScale / onSessions /
                toggleWeb / openMenu / dragStart / dragMove / dragEnd)
renderer/       index.html + renderer.js: sprite animation driver + session bubbles
tests/          mock-dsh.cjs — deterministic mock DSH server for credential-free screenshots
```

## Notes

- The renderer is a `file://` page; the main process (plain Node) does all DSH
  API calls and ships snapshots, the manifest, scale and session lists over IPC
  (CORS-free). Sprite sheets are loaded from
  `http://127.0.0.1:3080/whale-girl/assets/characters/<character>/<sheet>`.
- `contextIsolation` is off so the preload can expose `window.pet` in the
  renderer's world (contextBridge callback crossing proved unreliable here).
  The app loads only local files and talks only to loopback DSH.
- The window is manually dragged over IPC instead of `-webkit-app-region: drag`
  because a draggable region swallows clicks; a press that moves less than 5px
  is treated as a click.

## Credits

- Built on the whale-girl plugin ecosystem:
  [vlln/whale-girl](https://github.com/vlln/whale-girl) — external-consumer API
  contract (MIT, © Sam Gao (vlln)); per-session endpoint contributed in
  [xiaoshihou514/whale-girl](https://github.com/xiaoshihou514/whale-girl)
  (`codex/external-state-api`).
- Pet character「鲸鱼娘」: original by
  [上善](https://www.pixiv.net/users/62155430), redesign
  [ZipZipPipe](https://space.bilibili.com/4168597). Sprite sheets are loaded at
  runtime from the whale-girl plugin; this repository contains no character
  artwork.

## License

MIT. See [LICENSE](LICENSE). Character artwork is licensed by its authors as
declared in the whale-girl project; this shell does not redistribute it.
