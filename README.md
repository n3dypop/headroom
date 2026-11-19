# Headroom

Headroom shows how much of your **Claude Code** and **Codex** usage limits is left (the 5-hour and weekly windows, with their reset times) at a glance, on an iPhone home-screen or lock-screen widget.

- **It is built not to spend your quota.**
  - Values come from the tools themselves: Claude Code's `claude -p "/usage"` and its statusLine, and Codex's `codex app-server` (`account/rateLimits/read`).
  - `/usage` is a local command. After every run, the agent checks the result for proof that no model request was made.
  - If the agent cannot confirm this, it stops fetching Claude values automatically until you check and resume.
- **It never reads your Claude or Codex credentials.** Sign-in is handled by each CLI; Headroom only runs the CLI.
- **No account data leaves your PCs.** The server stores usage values, window names, reset times, plan names and fixed status codes, plus the PC names you choose. It stores no tokens, emails, names, organization or account IDs, raw CLI output or file paths.
- **It stays on Cloudflare's free plan.** Client reads touch only a few precomputed rows, and all other work runs within a daily budget that the Worker counts before it touches D1.

## How it works

```
 Your PCs (Windows / macOS, not always on)
   headroom agent (Rust, runs in the background)
     ├─ Claude: claude -p "/usage" every 5 min + statusLine
     └─ Codex : codex app-server, account/rateLimits/read every 5 min
        │  PUT with a per-PC write token
        ▼
 Cloudflare Worker + D1 (free plan)
   merges all PCs, keeps short history, computes pace / forecast / events (Cron, every 5 min)
        │  GET with a per-device read token
        ▼
 iPhone: Scriptable widget (home screen: small / medium / large, lock screen: 3 styles)
```

| Component | Path | Language |
|---|---|---|
| Agent (collector) | [`agent/`](agent/) | Rust |
| Server (Worker + D1) | [`packages/worker/`](packages/worker/) | TypeScript (runs on Cloudflare Workers) |
| Shared logic: types, merging, history, view, events | [`packages/core/`](packages/core/) | TypeScript |
| iPhone widget | [`packages/scriptable/`](packages/scriptable/) | JavaScript (Scriptable) |
| Test fixtures (masked) | [`fixtures/`](fixtures/) | JSON |
| Release packaging | [`scripts/`](scripts/) | PowerShell / shell |

## Install

See **[docs/install.md](docs/install.md)**. In short:

1. Deploy the Worker and D1 to your Cloudflare account (once).
2. On each PC: install and sign in to Claude Code and/or Codex CLI, install the Headroom agent from the release package (or build it), and store its write token.
3. On the iPhone: paste the widget script into Scriptable and enter the Worker URL and a read token.

## Requirements

| Dependency | Needed for | Notes |
|---|---|---|
| Claude Code CLI (standalone install) with a Claude subscription (Pro, Max or higher) | Claude values | Checked with 2.1.325 |
| Codex CLI (standalone install), signed in with ChatGPT | Codex values | Needs `app-server` and `account/rateLimits/read`. Developed against 0.169.0 |
| Windows 10/11 or macOS | Agent | macOS packaging is provided; macOS support is still being verified |
| Cloudflare account (Workers Free plan), Node.js 24+ | Deploying the Worker | `wrangler` is used through `npx` |
| iPhone with [Scriptable](https://apps.apple.com/app/id1405459188) | Widget | |
| Rust (stable), Node.js 24+ | Building from source / development only | |

Rust dependencies and why each is used are listed in [`agent/Cargo.toml`](agent/Cargo.toml). The TypeScript packages have no runtime dependencies; development needs only `typescript` and `@types/node`.

## Development

```bash
npm install
npm test                 # TypeScript tests (core, worker, widget)
npm run typecheck
cargo test --locked --manifest-path agent/Cargo.toml
cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets
```

TypeScript runs directly on Node.js 24 without a build step, so only erasable syntax is used (no `enum`, `namespace` or parameter properties).

## Status and plans

Headroom is a personal project in active development. Planned next: more clients that read the same server API, namely a Windows system-tray app, a macOS widget and menu-bar app, and a Discord bot.

## License

MIT. See [LICENSE](LICENSE).
