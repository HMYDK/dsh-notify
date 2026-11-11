# dsh-notify · desktop notifications for DeepSeek Harness

[![npm](https://img.shields.io/npm/v/@hmydk/dsh-notify?label=npm)](https://www.npmjs.com/package/@hmydk/dsh-notify)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

A DeepSeek Harness (DSH) plugin that raises a native desktop notification when a session **finishes a
turn** or **waits for your approval**. Banners appear only while the Harness window is in the
background; clicking one focuses Harness.

English | [中文](README.zh.md)

| Turn complete | Approval needed |
|---|---|
| <img src="https://cdn.jsdelivr.net/gh/HMYDK/dsh-notify@main/docs/screenshots/turn-complete.png" width="420" alt="Turn-complete notification: 任务完成 / Codex 任务完成通知机制调研" /> | <img src="https://cdn.jsdelivr.net/gh/HMYDK/dsh-notify@main/docs/screenshots/approval-requested.png" width="420" alt="Approval notification: 需要审批 / Codex 任务完成通知机制调研 · bash" /> |

- Top-level sessions only: subagents and teammates stay silent, so parallel work doesn't spam you.
- Focus-aware by default (`condition: "unfocused"`); switch to `always` for every event.
- Settings page for the master switch, focus condition, event types and approval grace.

## Install

Requires DeepSeek Harness `>= 0.2.1-rc.3` and notification permission for the Harness app (macOS asks
on the first banner).

**Desktop**: **Plugins** page → **Add plugin** → enter `@hmydk/dsh-notify` → install → **Enable now**
(the row is `dsh-notify`) → reload the window.

**`dsh web` or another profile**:

```sh
dsh plugin --profile web add @hmydk/dsh-notify
```

Restart `dsh web` and reload the page. Uninstall with
`dsh plugin --profile web remove @hmydk/dsh-notify`, or use **Remove** on Desktop's Plugins page.

## Configuration

**Settings → Notifications** (settings live in the account menu). Changes are written back to the
profile's `cordis.patch.yml` and apply immediately; **Send a test notification** previews one.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `condition` | `unfocused` | `unfocused`: only while Harness is in the background; `always`: every event |
| `events` | both | Event types that notify: `turn-complete`, `approval-requested` |
| `approvalGraceMs` | `2000` | Wait this long before alerting an approval (0–60000); auto-resolved requests stay silent |

Releases without the settings page: edit the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`) instead:

```yaml
- id: dsh-notify
  config:
    condition: always
```

## Limitations

- Routes are loopback-only, so a Web GUI opened through remote access gets no notifications.
- One banner per open page/tab.
- Root sessions only; no per-teammate alerts.
- `approvalGraceMs` is a heuristic: an approval resolved automatically just after the grace window may
  still produce one banner.
- macOS attributes banners to the Harness app; allow it in System Settings.

<details>
<summary>Troubleshooting</summary>

```sh
PORT=53221   # port from the GUI URL
curl -N http://127.0.0.1:$PORT/notify/events   # Host half mounted: one config frame, then the stream stays open
curl -s http://127.0.0.1:$PORT/notify/status   # browser half connected: clients / lastAck
curl -s "http://127.0.0.1:$PORT/notify/test?kind=turn-complete"   # preview a banner
```

</details>

## Development

Plain ESM, no build step: `index.js` is the Host half, `client.js` the browser half, `locale/*.json` the
copy. Reinstall and restart after editing; the browser half reloads with the page.

Day-to-day work happens on `dev`; `main` is protected and only accepts pull requests, so `dev` is merged
into it when cutting a release.

```sh
git switch dev
npm run setup:hooks   # once per clone: local pushes to main are rejected
```

Before installing from this checkout with `link:`, run `pnpm install --prod`, then:

```sh
dsh plugin --profile web add link:$PWD
```

Release: bump `version` in `package.json`, open a PR from `dev` into `main`, merge it, then tag:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

The [Release workflow](.github/workflows/release.yml) checks the tag against the version, publishes to
npm over OIDC and creates a GitHub Release; no npm token lives in the repository.

## License

MIT
