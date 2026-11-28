# Headroom

**See how much of your Claude Code, Codex and Gemini usage limits is left, on your iPhone, at a glance.**

Headroom reads the 5-hour and weekly usage limits of **Claude Code**, **Codex** and **Gemini** (the Antigravity CLI) on your PCs, merges them on your own Cloudflare Worker, and shows them in an iPhone widget: what is left of each limit, when it resets, how fast you are using it, and whether you are likely to run out before the reset.

- **Home screen widgets** (small, medium and large, with a weekly chart on the large one) and **lock screen widgets** (three styles), made with [Scriptable](https://apps.apple.com/app/id1405459188).
- **A details page** on tap: every limit with its reset time, pace, forecast and recent events.
- **Optional notifications** when a limit is about to run out, and at reset times.
- **Several PCs at once.** Each PC reports what it sees; the server merges them, so the widget shows one view of your accounts.

## Design principles

- **It does not spend your quota.** Values come from the tools themselves, never from extra model requests: Claude Code's `claude -p "/usage"` and statusLine, Codex's `codex app-server` (`account/rateLimits/read`), and the Antigravity CLI's `agy -p "/usage"` and statusLine. After each `/usage` run, the agent checks the result for proof that no model request was made, and stops fetching that provider until you check if it can't confirm this.
- **It never reads your Claude, Codex or Gemini credentials.** Each CLI handles its own sign-in; Headroom only runs the CLI and reads what it prints.
- **No account data leaves your PCs.** The server stores usage values, limit names, reset times, plan names, fixed status codes and the PC names you choose. It stores no tokens, emails, names, organization or account IDs, raw CLI output or file paths.
- **It runs on Cloudflare's free plan.** Readers touch only a few precomputed rows, and all other work runs within a daily budget that the Worker counts before it touches D1.
- **You run everything yourself.** There is no shared service: the server is a Worker in your own Cloudflare account, and every device has its own token.

## Supported tools

| Tool | What Headroom reads | Default |
|---|---|---|
| Claude Code (Pro, Max or higher subscription) | `claude -p "/usage"` about every 15 minutes, plus the statusLine while you use it | On |
| Codex CLI (signed in with ChatGPT) | `codex app-server`, `account/rateLimits/read`, about every 15 minutes | On |
| Antigravity CLI, `agy` (signed in with a Google account) | `agy -p "/usage"` about every 15 minutes, plus its statusLine | On only on Windows 11 with `agy` 1.5.14; can be turned on elsewhere |

## How it works

```
 Your PCs (Windows / macOS, not always on)
   headroom agent (Rust, runs in the background)
     ├─ Claude: claude -p "/usage" + statusLine
     ├─ Codex : codex app-server (account/rateLimits/read)
     └─ Gemini: agy -p "/usage" + statusLine
        │  PCs take turns through the server; longer gaps while nothing changes
        │  PUT with a per-PC write token
        ▼
 Cloudflare Worker + D1 (your account, free plan)
   merges all PCs, keeps a short history, computes pace, forecasts and events (Cron, every 5 minutes)
        │  GET with a per-device read token
        ▼
 iPhone: Scriptable widgets, a details page and optional notifications
```

## Getting started

The full guide is **[docs/install.md](docs/install.md)**. In short:

1. **Server** (once): deploy the Worker and its D1 database to your Cloudflare account, and create a write token for each PC and a read token for the iPhone. [Guide](docs/install.md#1-server-cloudflare-worker--d1)
2. **Agent** (each PC): install and sign in to the CLIs you use, download the Headroom agent from [Releases](https://github.com/n3dypop/headroom/releases) (or build it), store its write token and install it to start at sign-in. [Guide](docs/install.md#2-agent-each-pc)
3. **Widget** (iPhone): paste `packages/scriptable/Headroom.js` into Scriptable, enter the Worker URL and the read token, and add the widget. [Guide](docs/install.md#3-iphone-widget-scriptable)

Updating, removing and troubleshooting are covered in the same guide ([4](docs/install.md#4-updating-and-removing), [5](docs/install.md#5-troubleshooting)).

## Requirements

**To use Headroom**

| What | Needed for | Notes |
|---|---|---|
| Windows 10/11 (x64) or macOS on Apple silicon | The agent | Intel Macs are not supported. macOS support is still being verified |
| Claude Code CLI (standalone install, or Homebrew `claude-code@latest` on macOS) with a Claude subscription (Pro, Max or higher) | Claude values | 2.1.325 or later |
| Codex CLI (standalone install), signed in with ChatGPT | Codex values | Needs `app-server` and `account/rateLimits/read`. Developed against 0.169.0 |
| Antigravity CLI (`agy`), signed in with a Google account | Gemini values (optional) | 1.5.13 or later. Its statusLine must be set up ([guide](docs/install.md#28-gemini-antigravity-cli)) |
| Cloudflare account (Workers Free plan) and Node.js 24+ | Deploying the server | `wrangler` runs through `npx`; nothing to install globally |
| iPhone with [Scriptable](https://apps.apple.com/app/id1405459188) | The widget | Transparent backgrounds need iOS 27.2 and Scriptable 1.8 or newer |

You need at least one of the three CLIs.

**To build from source or develop**

| What | Notes |
|---|---|
| Rust (stable) | The agent. Its crates (`serde`, `serde_json`, `toml`, `notify`, `jiff`, `ureq` with the OS TLS, `keyring`, and the platform APIs) are listed with the reason for each in [`agent/Cargo.toml`](agent/Cargo.toml) |
| Node.js 24+ | The server, shared logic and widget. No runtime dependencies; development needs only `typescript` and `@types/node`. TypeScript runs directly on Node.js without a build step |

## Repository layout

| Path | What | Language |
|---|---|---|
| [`agent/`](agent/) | The agent that runs on each PC (collects and sends values) | Rust |
| [`packages/worker/`](packages/worker/) | The server: Cloudflare Worker and D1 schema | TypeScript |
| [`packages/core/`](packages/core/) | Shared logic: types, merging, history, the view and events | TypeScript |
| [`packages/scriptable/`](packages/scriptable/) | The iPhone widget | JavaScript (Scriptable) |
| [`clients/windows/`](clients/windows/) | Windows desktop client (preview): a notch on the screen edge and a tray icon, reading the server like the widget | Rust (Win32, Direct2D) |
| [`clients/macos/`](clients/macos/) | macOS desktop client (preview): the same notch and a menu bar item | Swift (AppKit) |
| [`fixtures/`](fixtures/) | Recorded CLI responses (masked) and shared test data | JSON |
| [`scripts/`](scripts/) | Release packaging | PowerShell / shell |
| [`docs/install.md`](docs/install.md) | Installation, updating and troubleshooting | |

## Development

```bash
npm install
npm test                 # TypeScript tests (core, worker, widget)
npm run typecheck
cargo test --locked --manifest-path agent/Cargo.toml
cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets
```

TypeScript uses only erasable syntax (no `enum`, `namespace` or parameter properties), since Node.js runs it as it is.

GitHub Actions runs these checks on every push to `main` and on pull requests: the Rust checks on Windows and macOS, the TypeScript checks on Ubuntu ([`ci.yml`](.github/workflows/ci.yml)). A tag `v<version>` that matches `agent/Cargo.toml` builds the Windows and macOS packages with build provenance attestations and attaches them to a draft release ([`release.yml`](.github/workflows/release.yml)).

## Status

Headroom is a personal project in active development. More clients that read the same server API are planned, such as a Windows system-tray app, a macOS widget and menu-bar app, and a Discord bot.

## License and trademarks

MIT. See [LICENSE](LICENSE).

Claude and Claude Code are trademarks of Anthropic, Codex and ChatGPT of OpenAI, and Gemini and Antigravity of Google. Headroom is not affiliated with or endorsed by any of them. No provider logos are included; the widget can use icons you supply ([guide](docs/install.md#3-iphone-widget-scriptable)).
