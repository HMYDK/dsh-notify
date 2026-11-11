# dsh-notify · DeepSeek Harness 桌面通知

[![npm](https://img.shields.io/npm/v/@hmydk/dsh-notify?label=npm)](https://www.npmjs.com/package/@hmydk/dsh-notify)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

DSH 插件：会话**完成一轮任务**或**等待你审批**时弹出系统桌面通知。默认只在 Harness 窗口不在前台时
提醒，点击通知回到 Harness。

| 任务完成 | 需要审批 |
|---|---|
| <img src="https://cdn.jsdelivr.net/gh/HMYDK/dsh-notify@main/docs/screenshots/turn-complete.png" width="420" alt="任务完成通知：任务完成 / Codex 任务完成通知机制调研" /> | <img src="https://cdn.jsdelivr.net/gh/HMYDK/dsh-notify@main/docs/screenshots/approval-requested.png" width="420" alt="需要审批通知：需要审批 / Codex 任务完成通知机制调研 · bash" /> |

- 只提醒根会话：子 agent、队友静默，多 agent 并行不刷屏。
- 默认失焦才提醒（`condition: "unfocused"`），可改成 `always`。
- 设置页可调总开关、提醒时机、事件类型和审批宽限。

## 安装

需要 DeepSeek Harness `>= 0.2.1-rc.3`，系统需允许 Harness 发通知（macOS 首次会询问）。

**Desktop**：左侧 **插件** 页 → **添加插件** → 输入 `@hmydk/dsh-notify` → 安装 → **立即启用**
（行名 `dsh-notify`）→ 刷新窗口。

**`dsh web` 或其它 profile**：

```sh
dsh plugin --profile web add @hmydk/dsh-notify
```

重启 `dsh web` 并刷新页面。卸载：`dsh plugin --profile web remove @hmydk/dsh-notify`，
或在 Desktop 插件页点 **移除**。

## 配置

**设置 → 通知**（设置入口在账户菜单）。改动会写回 profile 的 `cordis.patch.yml` 并即时生效；
**发送测试通知** 可立即预览一条。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `condition` | `unfocused` | `unfocused` 仅窗口失焦时提醒；`always` 总是提醒 |
| `events` | 全部 | 触发提醒的事件：`turn-complete`、`approval-requested` |
| `approvalGraceMs` | `2000` | 审批等待多久才提醒（0–60000）；自动放行的请求不打扰 |

没有设置页的旧版本可直接改 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: dsh-notify
  config:
    condition: always
```

## 已知限制

- 插件路由仅回环：通过远程访问打开的 Web GUI 收不到通知。
- 同时打开多个页面/标签，各自弹一条。
- 只提醒根会话，不按队友逐个提醒。
- `approvalGraceMs` 是启发式：宽限时间之后才被自动处理的审批仍可能多弹一次。
- macOS 上通知归属于 Harness App，需在系统设置里允许。

<details>
<summary>排查</summary>

```sh
PORT=53221   # 换成 GUI 地址里的端口
curl -N http://127.0.0.1:$PORT/notify/events   # Host 半是否挂载：先收到一帧 config，之后流保持打开
curl -s http://127.0.0.1:$PORT/notify/status   # 浏览器半是否连上：clients / lastAck
curl -s "http://127.0.0.1:$PORT/notify/test?kind=turn-complete"   # 预览通知
```

</details>

## 开发

纯 ESM，无构建：`index.js` 是 Host 半，`client.js` 是浏览器半，`locale/*.json` 是文案。改完重装并重启，
浏览器半刷新页面即可。

日常开发在 `dev` 分支；`main` 受保护、只能通过 PR 合入，发版时才把 `dev` 合过去。

```sh
git switch dev
npm run setup:hooks   # 新克隆后执行一次：本地直接 push main 会被拒绝
```

本地 `link:` 安装前先执行 `pnpm install --prod`，再：

```sh
dsh plugin --profile web add link:$PWD
```

发版：改 `package.json` 的 `version`，`dev` 开 PR 合入 `main` 后打 tag：

```sh
git tag v0.3.0 && git push origin v0.3.0
```

[Release workflow](.github/workflows/release.yml) 校验 tag 与版本一致后经 OIDC 发布到 npm 并创建
GitHub Release，仓库不需要 npm token。

## 许可证

MIT
