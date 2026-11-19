# Installing Headroom

Headroom has three parts. Set them up in this order:

1. **Server**: a Cloudflare Worker with a D1 database. You do this once.
2. **Agent**: runs on each PC that uses Claude Code or Codex (Windows x64, or macOS on Apple silicon).
3. **Widget**: Scriptable on the iPhone.

Each device gets its own token:

- Each PC gets a **write** token, which lets it send values under its own name only.
- Each reader gets a **read** token. Readers are the iPhone, and in the future other display clients.

Tokens are sent only in the `Authorization` header, never in URLs.

## Contents

- [1. Server (Cloudflare Worker + D1)](#1-server-cloudflare-worker--d1)
- [2. Agent (each PC)](#2-agent-each-pc)
- [3. iPhone widget (Scriptable)](#3-iphone-widget-scriptable)
- [4. Updating and removing](#4-updating-and-removing)
- [5. Troubleshooting](#5-troubleshooting)

---

## 1. Server (Cloudflare Worker + D1)

**What you need:**
- A Cloudflare account on the **Workers Free** plan. Check the plan in the dashboard first.
  - On the free plan, going over a limit only makes requests fail until the daily reset; nothing is billed.
  - Headroom is designed to stay within the free limits. Do not switch to Workers Paid for it, because Paid bills overage with no cap.
- Node.js 24 or later.
- This repository. Run the commands below in `packages/worker`; `wrangler` runs through `npx`.

The committed `wrangler.toml` holds placeholders only. Keep your real values in a local copy named `wrangler.prod.toml`, which is git-ignored, and pass `-c wrangler.prod.toml` to every production command. The real values are the database ID and your `workers.dev` host, which contains your account subdomain.

1. **Create the database.**

   ```bash
   npx wrangler d1 create headroom
   ```

   Copy `wrangler.toml` to `wrangler.prod.toml` and put the printed `database_id` into the copy.

2. **Create the tables.**

   ```bash
   npx wrangler d1 migrations apply headroom --remote -c wrangler.prod.toml
   ```

3. **Deploy.**

   ```bash
   npx wrangler deploy -c wrangler.prod.toml
   ```

   Note the printed host, `headroom.<your-subdomain>.workers.dev`. The Worker refuses every request with 503 until `ALLOWED_HOST` is set.

4. **Set `ALLOWED_HOST`.** In `wrangler.prod.toml`, set `ALLOWED_HOST` to that host and deploy again. The Worker answers only on this host. Preview URLs are disabled.

5. **Create one token per device.** Run these from the repository root:

   ```bash
   node packages/worker/scripts/new-token.ts read iphone
   node packages/worker/scripts/new-token.ts write <collector-id>   # one per PC, e.g. win-desktop, macbook
   ```

   Each run prints two things:
   - **The token.** Give it to that device only; it cannot be shown again.
   - **A line for the `TOKENS` array.** It holds a SHA-256 hash of the token, never the token itself.

   About PC names (`collector-id`):
   - Write tokens in `TOKENS` may cover at most **16 different PC names**. With 17 or more names, the Worker rejects every token, read tokens included.
   - The server accepts at most 32 PC names over its lifetime, and they cannot be removed.
   - When you replace a PC, reuse its old name.
   - Do not use a name that identifies you personally, such as a hostname containing your name.

6. **Store the token list as a secret.** Put all the lines into one JSON array. Go back to `packages/worker` and run:

   ```bash
   cd packages/worker
   npx wrangler secret put TOKENS -c wrangler.prod.toml
   ```

   Whenever you add or revoke a device, store the whole array again. To revoke a lost device, remove its line and store the array again.

7. **Check.** A request without a token must get 401, and a request to any other host or path must get 404.

   ```bash
   curl -i https://headroom.<your-subdomain>.workers.dev/v2/view
   ```

The Worker runs a Cron job every 5 minutes. It computes derived values (recent usage, pace, forecasts) and events (thresholds, limit reached, reset, collection stopped).

**What is stored:**
- D1 holds usage percentages, window IDs and labels, reset times, plan names from a fixed list, fixed status codes and texts, the PC names you chose, and send and receive times.
- It never holds tokens, emails, names, organization or account IDs (or their hashes), raw CLI output or file paths.

**Limits that keep D1 within the free plan:**
- Each client read touches only precomputed rows, at most 3.
- All other work (uploads from PCs, fetch turns, Cron) reserves rows from a daily budget before it touches D1.
- When the budget is used up, the Worker answers 503. Agents keep their data and send it again after the daily reset.
- The free plan's D1 limits apply to the whole Cloudflare account, but each Headroom database counts its own budget. If the account has a second Headroom database, for example one for testing, set `D1_BUDGET_PERCENT` in each one's `[vars]` so the shares add up to 100 or less, for example `D1_BUDGET_PERCENT = "80"` and `D1_BUDGET_PERCENT = "20"`. Each share must be at least 13, or the Cron job never runs. Empty means 100; any value that is not a whole number from 1 to 100 stops all uploads.

## 2. Agent (each PC)

The agent must run as the **same OS user** that is signed in to the CLIs.

### 2.1 Claude Code CLI (for Claude values)

Install the **standalone** CLI. The copy bundled with the desktop app changes path on every update, so the agent would lose track of it.

```powershell
# Windows (PowerShell, no admin rights needed)
irm https://claude.ai/install.ps1 | iex
```

```bash
# macOS
curl -fsSL https://claude.ai/install.sh | bash
```

**macOS with Homebrew:** use the `claude-code@latest` cask instead. Its `/opt/homebrew/bin/claude` path stays the same across updates. The `claude-code` cask follows the stable channel, which can be older than 2.1.325; with an older CLI, the agent does not run `/usage`. Update it with `brew upgrade --cask claude-code@latest` (`claude update` does not update a Homebrew install).

```bash
# New install
brew install --cask claude-code@latest
# Switching from the stable cask (the two casks conflict, so remove the stable one first)
brew uninstall --cask claude-code && brew install --cask claude-code@latest
```

Open a new terminal, then sign in with your Claude subscription (Pro, Max or higher) and check:

```bash
claude --version        # 2.1.325 or later
claude auth login
claude auth status
```

If `which -a claude` lists more than one `claude`, the agent uses the first one on its `PATH`. Remove the older copy, or set `claude_bin` (2.4) to the one you want.

**Accounts where the agent does not run `/usage`:** API-key logins, organization (Team / Enterprise) plans, and machines with managed settings. In these cases the agent cannot confirm that `/usage` is free, so it skips it. If you set up the statusLine (2.6), it still uses the values Claude Code reports there.

### 2.2 Codex CLI (for Codex values)

Install the **standalone** CLI.

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -Command "irm https://chatgpt.com/codex/install.ps1 | iex"
```

```bash
# macOS
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Default locations are `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` on Windows and `~/.local/bin/codex` on macOS. Open a new terminal, then sign in with ChatGPT and check:

```bash
codex --version
codex login             # or: codex login --device-auth (beta) without a browser
codex login status      # must say you are logged in with ChatGPT
```

The agent starts Codex's App Server with the agent's own environment. A custom `CODEX_HOME` set only in your shell is not passed to the background agent, so use the default location. Running the background agent with a custom `CODEX_HOME` has not been verified.

### 2.3 Get the agent

**From a release package** (no build tools needed):

Packages are published on the [Releases page](https://github.com/n3dypop/headroom/releases). Each package has a `.sha256` file next to it; the Releases page also shows each file's SHA-256 digest. Packages from 0.1.3 on are built by the repository's Release workflow on GitHub Actions. To check that a downloaded package came from that workflow and that version's tag, use the [GitHub CLI](https://cli.github.com/) (sign in once with `gh auth login`):

```bash
gh attestation verify <file> --repo n3dypop/headroom --signer-workflow n3dypop/headroom/.github/workflows/release.yml --source-ref refs/tags/v<version>
```

In the steps below, set `V` to the version you install (for example `0.1.4`).

Always download and extract into a new, empty folder. An older package you keep for rollback must not be overwritten, even one with the same version.

- **Windows:** download the zip into a new folder, check its SHA-256, extract it, then run the next steps from inside the folder it contains:

  ```powershell
  $ErrorActionPreference = 'Stop'
  $V = '<version>'
  $EXPECTED = '<sha256 of the zip>'
  $F = "headroom-$V-windows-x64.zip"
  $d = New-Item -ItemType Directory "headroom-$(Get-Date -Format yyyyMMddHHmmss)"
  Set-Location $d
  Invoke-WebRequest "https://github.com/n3dypop/headroom/releases/download/v$V/$F" -OutFile $F
  if ((Get-FileHash $F -Algorithm SHA256).Hash -ne $EXPECTED) { throw 'SHA-256 mismatch' }
  Expand-Archive $F -DestinationPath .
  Set-Location "headroom-$V-windows-x64"
  ```

- **macOS:**
  - Download with `curl`, not a browser. A browser download marks the file as quarantined, and the binaries are not notarized.
  - Check the archive against its SHA-256 value from the Releases page.
  - Run the next steps from inside the folder the archive contains.

  ```bash
  set -euo pipefail
  V=<version>
  EXPECTED=<sha256 of the tar.gz>
  F="headroom-$V-macos-arm64.tar.gz"
  D="headroom-$(date +%Y%m%d%H%M%S)"
  mkdir "$D"
  cd "$D"
  curl -fsSLO "https://github.com/n3dypop/headroom/releases/download/v$V/$F"
  echo "$EXPECTED  $F" | shasum -a 256 -c -
  tar -xzf "$F"
  cd "headroom-$V-macos-arm64"
  ```

  If a version has no macOS package yet, build it on a Mac from the source of the same tag with `scripts/package-macos.sh`, or use **From source** below.

**From source** (Rust stable). The binaries are then in `agent/target/release/`; run the next steps from there.

```bash
cargo build --release --locked --manifest-path agent/Cargo.toml
```

The server and widget steps (1 and 3) use files from the source repository. A release package contains only the agent.

### 2.4 Configure (before installing)

The agent reads its settings when it starts, so write them before you install it. If you change them later, restart the agent: run `headroom stop`, then `headroom start`.

1. **Create `~/.headroom/config.toml`.**

   To use another folder, set `HEADROOM_HOME` to its **absolute** path and create `config.toml` directly inside it. The variable must reach both the current shell (for `install`) and the agent that starts after login:
   - **Windows:** run both `setx HEADROOM_HOME "<folder>"` (for later logins) and `$env:HEADROOM_HOME = "<folder>"` (for this shell) before `install`.
   - **macOS:** `export HEADROOM_HOME="<folder>"` before `install`; `install` stores it in the LaunchAgent. Also add the export to your shell profile, so `headroom status` reads the same folder.

   After logging in again, check that `headroom status` shows the folder you expect and `Agent: running`.

   With a custom folder, Claude Code must also run with the same `HEADROOM_HOME`, because the statusLine command (2.6) inherits Claude Code's environment. Otherwise statusLine values go to the default folder. Keeping the default folder avoids this.

   ```toml
   collector_id = "win-desktop"      # the name you created the write token for; required when sending

   [push]
   url = "https://headroom.<your-subdomain>.workers.dev"   # leave out [push] to collect locally only

   [claude]
   enabled = true
   claude_bin = ""                   # empty: find claude on PATH
   interval_min = 5                  # how often to run /usage (does not use quota)

   [codex]
   enabled = true
   codex_bin = ""                    # empty: config, then HEADROOM_CODEX_BIN, then PATH, then the default location
   interval_min = 5

   [schedule]
   idle_interval_min = 10            # stretch the interval up to this when nothing changed for 30 minutes
   own_fetch_min = 60                # longest wait for another PC's turn before fetching on this PC
   ```

   When several PCs are on, they take turns fetching through the server, so the same values are not fetched twice. A PC that stops with `headroom stop` hands its turn back. Another PC takes over when its own next fetch is due: a PC told to wait asks again within one fetch interval plus 2 minutes, however long the turn was held for. A PC that shuts down without `headroom stop` keeps the turn until it runs out, which can take up to an hour while a limit is reached.

2. **Store the PC's write token.**
   - It goes to the OS credential store (Windows Credential Manager or the macOS Keychain). It is never written to a file or shown on screen.
   - `credentials set` refuses typed input, because typed input would be echoed. Pipe the token in from a masked prompt instead.
   - Run this from the folder from step 2.3.

   ```powershell
   # Windows (PowerShell 7)
   Read-Host -MaskInput 'Worker token' | .\headroom.exe credentials set
   ```

   ```bash
   # macOS (zsh), while logged in to the desktop
   read -rs 'T?Worker token: ' && printf '%s\n' "$T" | ./headroom credentials set; unset T
   ```

   On macOS, Keychain access is tied to the binary's signature. After an update, macOS may ask you to allow access again.

### 2.5 Install

From the same folder:

```powershell
.\headroom.exe install        # Windows
```

```bash
./headroom install            # macOS
```

`install` does four things:
1. Copies `headroom` and `headroomw` to the `bin` folder under `~/.headroom` (or `HEADROOM_HOME`). It prints the location as `Executables:`.
2. Registers the agent to start at login:
   - Windows: a per-user `Run` registry entry for the windowless `headroomw.exe`.
   - macOS: a LaunchAgent. Its `PATH` includes the folders where `claude` and `codex` were found.
3. Starts the agent.
4. Prints the installed path and a ready-made statusLine setting.

If `install` warns that a CLI was not found on `PATH`, set its absolute path in the config (2.4) and run `install` again.

`install` does not change your shell's `PATH`. Either add the `Executables:` folder to `PATH`, or call the installed binary by its full path. The commands below are written as `headroom`.

To confirm it works, run `headroom status`. The "Push" line shows the result of the first upload.

### 2.6 Optional: Claude Code statusLine

With the statusLine, values arrive while you use Claude Code instead of every 5 minutes. Use the line that `install` printed, or add it to `~/.claude/settings.json` yourself. Quote the path, because a home folder may contain spaces:

```json
{ "statusLine": { "type": "command", "command": "\"C:/Users/<you>/.headroom/bin/headroom.exe\" statusline" } }
```

On macOS, the path is `/Users/<you>/.headroom/bin/headroom`. These examples assume the default folder; with `HEADROOM_HOME`, use the `Executables:` folder. If you already have a statusLine, keep it with `headroom statusline --then "<your command>"`.

### 2.7 Commands

| Command | What it does |
|---|---|
| `headroom status` | Shows the last results, the next fetch, the agent state and the send state |
| `headroom collect [--provider claude\|codex] [--force] [--accept-account]` | Fetches once and prints the snapshot. `--force` resumes after a safety stop. `--accept-account` resumes after an account switch (use it with `--provider`) |
| `headroom start` / `headroom stop` | Starts the agent, or stops it at the next safe point |
| `headroom install` / `headroom uninstall` | Registers and starts the agent, or stops and unregisters it |
| `headroom credentials set` / `headroom credentials clear` | Stores or deletes the Worker token |
| `headroom statusline [--then "<cmd>"]` | Command for the Claude Code statusLine |
| `headroom version` | Prints the version |

**Files** (`~/.headroom/`, or `HEADROOM_HOME`):

| File | Contents |
|---|---|
| `config.toml` | Settings |
| `state-*.json` | Per-provider state |
| `snapshot.json` | This PC's latest values |
| `outbox.json` | Values not sent yet and the send state (no credentials) |
| `schedule.json`, `agent.session`, `agent.session.lock` | When the running agent next checks each provider, for `headroom status` |
| `logs/agent.log` | Agent log, rotated at 1 MB × 3 (no tokens, IDs or emails) |
| `bin/` | The installed binaries |

## 3. iPhone widget (Scriptable)

1. Install [Scriptable](https://apps.apple.com/app/id1405459188).
2. **Get the script.**
   - Use `packages/scriptable/Headroom.js` as it is.
   - Or build a copy with provider icons:
     1. Put `claude.png` and `codex.png` (16–1024 px) in `packages/scriptable/icons/`. These are not included because they are third-party logos.
     2. Run `node packages/scriptable/scripts/build.ts`.
     3. Use `packages/scriptable/dist/Headroom.js`.
3. In Scriptable, create a new script named `Headroom` and paste the whole file.
4. **Run it once inside the app** and enter:
   - the Worker URL: the origin only, like `https://headroom.<your-subdomain>.workers.dev`;
   - a **read** token.

   They are saved together in the iPhone Keychain, never in the script.
5. Add a Scriptable widget to the home screen or lock screen and choose the `Headroom` script.
6. Optionally set the widget's **Parameter**:

   | Parameter | Shows |
   |---|---|
   | (empty) | Home screen: both providers. Lock screen: the limit with the least left |
   | `claude` / `codex` | Only that provider |
   | `top` | The tightest limit of each provider |
   | `5h`, `weekly`, `claude 5h`, `codex weekly` | Lock screen: that limit |
   | `claude 5h, codex 5h`, `both weekly` | Lock screen: two limits side by side |
   | `demo:<name>` | Sample data to preview every state (`normal`, `runout`, `no5h`, `stale`, `reset`, `offline`, `error`, `nochart`) |

To change or remove the settings, run the script in the app and choose **Edit settings** or **Remove settings**.

iOS decides how often widgets refresh, usually every 15–60 minutes. Countdowns to the reset keep running between refreshes.

## 4. Updating and removing

- **Agent:**
  1. Keep a copy of the old package.
  2. Run `install` from the new package; it stops the running agent, replaces the binaries and starts the agent again.
  3. If `install` fails, run `install` from the old package to restore it.
- **Agent removal:** `headroom uninstall` stops the agent and removes the login entry. Then delete `~/.headroom` if you no longer need it, and run `headroom credentials clear` first if you want the token removed from the credential store.
- **Server:** pull the new source, then:
  1. Apply new migrations with `npx wrangler d1 migrations apply headroom --remote -c wrangler.prod.toml`.
  2. Deploy with `npx wrangler deploy -c wrangler.prod.toml`.

  Normally you apply migrations before deploying. **Exception:** a migration that only drops a table is applied **after** deploying the Worker that no longer uses it. Its header comment says so.
- **Widget:** update the server first, then paste the new script over the old one (a newer widget may ask the server for data an older server doesn't serve). Settings are kept.

## 5. Troubleshooting

- **First check:** `headroom status` shows the last error per provider and the send result.
- **Send result says the PC's clock is ahead of or behind the destination's:** the Worker refuses uploads from a PC whose clock is more than 2 minutes off, because it uses the PC's times as they are. Turn on automatic time sync (Windows: Settings > Time & language > Set time automatically; macOS: System Settings > General > Date & Time). Observations the agent had queued when it was refused are dropped (they were stamped by the wrong clock), and it takes no fetch turn until a send goes through, so another PC fetches meanwhile.
- **Codex `account_changed`:** the CLI's account changed, so fetching stopped to avoid mixing histories. Check that it is the right account, then run `headroom collect --provider codex --accept-account`.
- **Claude account change:** same as Codex, with `--provider claude`.
- **Claude safety stop:** fetching stopped because the agent could not confirm that `/usage` used no quota.
  - Possible causes: `/usage` did not finish in time, its result did not show the expected local-only output, or it may have been sent to the model.
  - After a safety stop, the agent does not run `/usage` again on its own.
  - Before retrying: read the reason in `headroom status`, and check `claude --version` (a newer CLI may have changed `/usage`).
  - Retry once with `headroom collect --provider claude --force`, and check that `headroom status` shows a normal result.
- **Claude `last error unsupported_cli`:** the `claude` the agent found is older than 2.1.325, or its version could not be read, so the agent does not run `/usage`. Update the CLI (see 2.1; with Homebrew, use `claude-code@latest`), then run `headroom stop` and `headroom start`.
- **`Push: ... last result Cannot connect to the destination`:** the agent could not reach the URL in `config.toml`. Check that `curl -i <url>/v2/view` returns 401. Fix the URL if needed, then restart the agent.
- **`Push: ... last result The destination rejected the credentials (401, 403)`:** the server refused this PC's token. Check that this PC's write token is in `TOKENS`, that `credentials set` stored this PC's token, and that `collector_id` matches the name you created the token for.
- **`next check ... (another PC holds the fetch turn; checks again then)`:** another PC is fetching the same values, so this PC waits and decides again at that time. Its own values in `snapshot.json` can look old; the widget shows the values the server merges from all PCs. `own_fetch_min` caps how long this PC waits: after that, it fetches without asking for the turn (unless its own retry backoff or a safety stop holds it).
- **Widget shows `Check your credentials`:** the read token is wrong or was revoked.
- **Widget shows `Can't reach the server`:** check the URL, or `ALLOWED_HOST` on the server.
- **Values look old:** `headroom status` shows when the agent last sent. The widget marks old values (for example `31m ago`) and estimated resets (`est.`).
