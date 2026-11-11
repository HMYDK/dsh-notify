# dsh-notify · DeepSeek Harness 桌面通知

![version](https://img.shields.io/badge/version-0.1.0-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

一个 DeepSeek Harness（DSH）插件 bundle，在下面两种情况下弹出**系统桌面通知**：

- 会话**完成一轮任务**（`turn-complete`）；
- 工具调用**正在等待你审批**（`approval-requested`）。

默认行为对齐 Codex 的 `unfocused` 模式：只在 Harness 窗口**不在前台**时提醒，你正盯着窗口时不会打扰；
想要每次都提醒，把 `condition` 改成 `always`。

[English](README.md) | 中文

## 效果预览

两条由 Harness App 自己弹出的原生系统通知：

| 任务完成通知 | 需要审批通知 |
|---|---|
| <img src="docs/screenshots/turn-complete.png" width="420" alt="任务完成通知：任务完成 / Codex 任务完成通知机制调研" /> | <img src="docs/screenshots/approval-requested.png" width="420" alt="需要审批通知：需要审批 / Codex 任务完成通知机制调研 · bash" /> |

- **任务完成提醒**：根会话从 `running` 变为 `idle`、且 Harness 窗口不在前台时弹出，横幅里带会话标题。
- **审批提醒**：工具调用在宽限时间后仍在等你审批才提醒，自动放行的请求不会打扰；横幅带会话名和工具名。
- **默认只在失焦时提醒**（`condition: "unfocused"`），可在设置里改成 `always`。
- **点击回到 Harness**：点通知会聚焦窗口。
- **只提醒顶层会话**：子 agent、队友一律静默，多 agent 并行时不刷屏。
- **设置页可配置**：插件行会自动生成设置页（总开关、触发条件、事件类型、审批宽限）。

通知文案跟随客户端语言；上面截图在中文环境截取，可用 [验证安装](#验证安装) 里的预览命令复现。

## 环境要求

- DeepSeek Harness `>= 0.2.1-rc.3`（桌面 App，或跑在 `127.0.0.1` 的 Web GUI）。
- 操作系统允许 Harness 发通知。macOS 首次会询问权限（系统设置 → 通知 → DeepSeek Harness）。

## 安装

已发布到 npm：[`@hmydk/dsh-notify`](https://www.npmjs.com/package/@hmydk/dsh-notify)。

**DeepSeek Harness Desktop**（不需要命令行）：

1. 打开左侧 **插件（Plugins）** 页。
2. 点 **添加插件（Add plugin）**，填 `@hmydk/dsh-notify`。
3. 安装完成后点 **立即启用（Enable now）**（插件行名为 `dsh-notify`）。
4. 刷新窗口（Cmd/Ctrl+R），浏览器半才会加载。

**`dsh web` 或其它 profile**（需要 `pnpm` 在 `PATH` 上）：

```sh
dsh plugin --profile web add @hmydk/dsh-notify
```

重启 `dsh web` 后刷新页面。命令会自动安装并选中对应的 bundle。

**从本仓库源码安装（开发用）**：先在本目录执行 `pnpm install --prod`，然后

```sh
dsh plugin --profile web add link:/绝对路径/dsh-notify
```

也可以用 `dsh plugin --profile web add github:HMYDK/dsh-notify` 直接装 `main` 分支的最新代码。
desktop profile 由桌面 App 独占管理，普通 `dsh plugin --profile desktop ...` 会被拒绝，Desktop 用户请走 **插件** 页面。

bundle patch 会挂载一个 `dsh-notify` 插件行：Host 半负责事件检测并通过回环路由推流，浏览器半负责弹系统通知。
安装完成后刷新一次 GUI 页面，浏览器半才会加载。

卸载：在 Desktop 插件页点 **移除**，或

```sh
dsh plugin --profile web remove @hmydk/dsh-notify
```

## 配置

插件行的设置页由 `Config` schema 自动生成，可直接在 **设置 → 插件 → dsh-notify** 里改；bundle patch 里也固定了默认值：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。 |
| `condition` | `unfocused` \| `always` | `unfocused` | 仅窗口失焦时提醒，或总是提醒。 |
| `events` | 数组，取值 `turn-complete`、`approval-requested` | 两者都开 | 触发提醒的事件类型。 |
| `approvalGraceMs` | 数字（0–60000） | `2000` | 审批请求等待多久才提醒；自动放行的请求不会打扰你。 |

## 验证安装

Host 半在 Harness Web 服务上暴露了三个**仅回环**的诊断接口（端口用 GUI 地址里的端口，例如 `http://127.0.0.1:53221`）：

```sh
# 1. Host 半是否挂载：会先打印一帧 config，然后流保持打开
curl -N http://127.0.0.1:53221/notify/events

# 2. 浏览器半是否连上：GUI 页面开着时 clients 应该是 1
curl -s http://127.0.0.1:53221/notify/status

# 3. 预览两种通知形态（忽略失焦条件）
curl -s "http://127.0.0.1:53221/notify/test?kind=turn-complete"
curl -s "http://127.0.0.1:53221/notify/test?kind=approval-requested"
```

`/notify/status` 里的 `lastAck` 会告诉你浏览器半最近一次事件的处理结果（`shown`、`suppressed`、
`filtered`、`disabled`、`unsupported`、`failed`、`clicked`），不用调试器就能看到整条链路。

## 工作原理

```
Host 进程                                     浏览器页面
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ agent/status  running→idle   │   SSE        │ EventSource /notify/events   │
│ approval/request（含宽限）    │ ───────────▶ │ 失焦条件判断                  │
│ /notify/events（推流）        │  `notify`    │ new Notification(title, body)│
│ /notify/status /notify/test  │ ◀─────────── │ POST /notify/ack             │
│ /notify/ack                  │  `config`/ack                                │
└──────────────────────────────┘              └──────────────────────────────┘
```

- **任务完成**：根会话 `agent/status` 从 `running` 变 `idle`。子 agent、队友等一律静默，避免多 agent 场景刷屏。
- **需要审批**：监听 `approval/request` waterfall，原样返回 `next()`，绝不改变审批结果；宽限定时器让自动放行的请求保持安静。
- 浏览器半负责失焦判断（`document.visibilityState` + `document.hasFocus()`）和通知本身，所以通知归属于 Harness App，点击会聚焦窗口。

## 安全与隐私

- 插件路由**仅限回环访问**：socket 地址、`Host` 头、转发头拒绝、同源标记四重校验。已配对的外部设备读不到会话标题。
- 数据不出本机：浏览器半只访问本地 Host 路由。
- `notify/test` 也只有本机可达。

## 已知限制

- 路由按设计仅回环，远程访问方式打开的 Web GUI 收不到通知。
- 每个打开的页面/标签页各弹一条；同时开多个标签会各自提醒。
- 只通知根会话，不按队友逐个提醒。
- `approvalGraceMs` 是启发式：在宽限时间之后才被自动处理的请求仍可能多弹一次。
- macOS 上通知归属于 Harness App，需要在系统设置里允许。

## 开发

纯 ESM，无需构建。`index.js` 是 Host 半（`apply` + `Config`），`client.js` 是浏览器半的
client-module 产物（`window.__ModuleLoader__.load({ id, factory })`），`cordis.patch.yml` 插入插件行，
`locale/*.json` 提供插件管理器的标题与描述。改完任一半后需重装/重启让 Host 半重新加载；浏览器半刷新页面即可。

用 `link:` 从本地目录安装时，Node 会从 checkout 目录解析插件自身依赖，而不是 profile 的
`node_modules`。请先在本目录执行一次 `pnpm install --prod`（或 `npm install --omit=dev`），
让 `@deepseek-ai/schemastery` 出现在本地 `node_modules` 下；从 npm 安装时会自动解析，无需额外步骤。

## 许可证

MIT
