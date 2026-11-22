# Installing Headroom

Headroom has three parts. Set them up in this order:

1. **Server**: a Cloudflare Worker with a D1 database. You do this once.
2. **Agent**: runs on each PC that uses Claude Code, Codex or Gemini (the Antigravity CLI) (Windows x64, or macOS on Apple silicon).
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

In the steps below, set `V` to the version you install (for example `0.2.0`).

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
   # interval_min = 15               # minutes between /usage runs (does not use quota); 15 when left out, never under 10

   [codex]
   enabled = true
   codex_bin = ""                    # empty: config, then HEADROOM_CODEX_BIN, then PATH, then the default location

   [schedule]
   idle_interval_min = 30            # the interval while nothing changed for 30 minutes
   idle_long_interval_min = 60       # ... and for 2 hours
   own_fetch_min = 120               # this PC asks for a fetch of its own after this long without one
   ```

   Each fetch is planned one interval after the last, with a ±20 % jitter (PCs don't fetch at the same moment). While the statusLine brings fresh values, the next fetch waits for them, up to an hour. Values from `interval_min = 5` in an earlier config are read as 10.

   When several PCs are on, they take turns fetching through the server, so the same values are not fetched twice. With `[push]` set, a PC fetches only when the server says it may, also right after a start, for its own fetch and for `headroom collect`; if the server can't be reached, it waits and asks again a few minutes later. A PC that stops with `headroom stop` hands its turn back. Another PC takes over when its own next fetch is due: a PC told to wait asks again within the longest jittered interval plus 3 minutes. A PC that hasn't fetched for `own_fetch_min` asks for a fetch of its own, which passes another PC's turn (one PC at a time).

   If a service answers that it is rate limiting the fetches, every PC waits (30, 60, 120, then 240 minutes, or longer if the service says so). If it denies access, every PC stops fetching that provider until you resume it (see 5).

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

With the statusLine, values arrive while you use Claude Code, between the agent's fetches. Use the line that `install` printed, or add it to `~/.claude/settings.json` yourself. Quote the path, because a home folder may contain spaces:

```json
{ "statusLine": { "type": "command", "command": "\"C:/Users/<you>/.headroom/bin/headroom.exe\" statusline" } }
```

On macOS, the path is `/Users/<you>/.headroom/bin/headroom`. These examples assume the default folder; with `HEADROOM_HOME`, use the `Executables:` folder. If you already have a statusLine, keep it with `headroom statusline --then "<your command>"`.

### 2.7 Commands

| Command | What it does |
|---|---|
| `headroom status` | Shows the last results, the next fetch, the agent state and the send state |
| `headroom collect [--provider claude\|codex\|gemini] [--force] [--accept-account \| --same-account]` | Asks the background agent to fetch once, when its plan and the server allow it, and prints the agent's values afterwards. The agent must be running (start it with `headroom start`); the command waits up to 2 minutes in all. `--force` fetches now, also after a safety stop, but still not past another PC's fetch in progress, a rate limit or an access denial. `--accept-account` resumes after an account switch. `--same-account` (Gemini) resumes after a change of limits of the same account. Use both with `--provider`; only the switch `headroom status` showed when you ran the command is accepted. The command exits with 1 when something it asked for wasn't done |
| `headroom collect --provider <name> --resume-access <stop> [--force]` | After an access denial: tries once to fetch again, for the stop that `headroom status` names. Add `--force` when a safety stop shows too. Exits with 0 only when the stop ended |
| `headroom collect --provider <name> ... --replace <attempt>` | With `--force` or `--resume-access`: replaces the fetch attempt whose result couldn't be checked, as `headroom status` names it (only that attempt, and only 5 minutes after it began) |
| `headroom collect --result <request>` | Shows what a collect the agent was still doing when the command stopped waiting did (the command names the request). Results are kept for a day |
| `headroom collect --reset-fetch-state` | Starts the fetch state (`schedule-plan.json`) anew when it can't be read on a PC without `[push]` (with the agent stopped) |
| `headroom start` / `headroom stop` | Starts the agent (reported once it is up), or stops it at the next safe point. A stop that can't wait for a long fetch stays: the agent stops once that fetch ends, and an agent started later isn't stopped by it |
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
| `schedule-seed.txt` | A random value made once on this PC that spreads its fetch times (never sent) |
| `bin/` | The installed binaries |

### 2.8 Gemini (Antigravity CLI)

Headroom can also show Gemini's limits, read with Google's Antigravity CLI (`agy`). Install `agy` and sign in to it once yourself.

- **On or off.** Set `enabled` under `[gemini]` in `config.toml`:

  ```toml
  [gemini]
  enabled = true    # or false
  ```

  Left out, the agent turns Gemini on only on Windows 11 (not Windows Server) with `agy` 1.5.14, the combination the whole fetch was checked on. To decide, it asks `agy --version` once when it starts; once Gemini is on, it checks the version again on its own schedule and whenever `agy` changes, and stops fetching if `agy` is updated to a version not checked yet (`headroom status` then shows `last error unverified_default`, and setting `enabled = true` keeps using that version; a version older than the oldest one Headroom checked shows `unsupported_cli` instead: update `agy`). Anywhere else, Gemini stays off until you set `enabled = true`. While it is off, nothing of `agy` runs. After a change, restart the agent (`headroom stop`, then `headroom start`). `headroom status` shows which applies. If `agy` isn't found, set its absolute path in `gemini_bin` under `[gemini]`.
- **What runs.** On the same schedule as the other providers (about every 15 minutes, taking turns between PCs), the agent runs `agy -p "/usage" --output-format json`. It reads the limits without using quota. Each run is checked for zero turns and zero tokens; if that can't be confirmed, Gemini stops with a safety stop.
- **statusLine (needed).** Gemini fetches only after Antigravity's statusLine has shown the agent the signed-in account once. Headroom keeps only a hash of the email, on this PC. In `~/.gemini/antigravity-cli/settings.json`, change only the `statusLine` key:

  ```json
  "statusLine": { "type": "command", "command": "\"C:\\Users\\<you>\\.headroom\\bin\\headroom.exe\" statusline --gemini", "enabled": true, "stack_with_default": true }
  ```

  Quote the path, because a folder may contain spaces. On macOS, the command is `"/Users/<you>/.headroom/bin/headroom" statusline --gemini`. With `HEADROOM_HOME`, use the `Executables:` folder (`install` prints the command). Headroom's command prints nothing, and `stack_with_default: true` keeps Antigravity's own line. If you already have a statusLine command, use `headroom statusline --gemini --then "<your command>"`.

  Then start `agy` once and wait for its status line to appear. You don't need to send a prompt (one would use quota). While you use `agy`, its status line also brings fresh values, and the agent's own run waits for them.

## 3. iPhone widget (Scriptable)

1. Install [Scriptable](https://apps.apple.com/app/id1405459188).
2. **Get the script.**
   - Use `packages/scriptable/Headroom.js` as it is.
   - Or build a copy with provider icons:
     1. Put `claude.png`, `codex.png` and `gemini.png` (16–1024 px, 64 KB at most) in `packages/scriptable/icons/`. These are not included because they are third-party logos. Crop each to what is visible (little transparent margin): a wide icon is drawn wider and shorter, so it looks as large as a square one.
     2. Optionally, put a second set with the same names in `packages/scriptable/icons/alt/`. **Settings › Display** in the app then switches each provider's icon between its two, on every widget and the details page at once.
     3. Run `node packages/scriptable/scripts/build.ts`.
     4. Use `packages/scriptable/dist/Headroom.js`.
3. In Scriptable, create a new script named `Headroom` and paste the whole file.
4. **Run it once inside the app** and enter:
   - the Worker URL: the origin only, like `https://headroom.<your-subdomain>.workers.dev`;
   - a **read** token.

   They are saved together in the iPhone Keychain, never in the script.
5. Add a Scriptable widget to the home screen or lock screen and choose the `Headroom` script.
6. Optionally set the widget's **Parameter**: words separated by commas or spaces, in any order and case. In the app menu, **Widget** > **Make a parameter** builds one and copies it, and **Parameter guide** lists them all. To see every state with sample values, use **Widget** > **Preview sample data**.

   | Parameter | Shows |
   |---|---|
   | (empty) | Home screen: Codex and Claude, and Gemini once it has values. Lock screen: the tightest limit, the one with the least left at its reset at the current pace (one already used up only when all are) |
   | `claude`, `codex`, `gemini` | Those providers, in that order (up to three) |
   | `5h`, `wk` | Only that limit (the provider's own 5-hour or weekly one), for example `claude, 5h` |
   | `most, 5h`, `most, wk` | Large: the provider using most of that limit, larger, then the others |
   | `5h, others`, `wk, others` | Lock screen (rectangular): rings of the other providers (the next tightest on the left, used-up ones on the right), to put beside a rectangle of `5h` or `wk` |
   | `…, notify` (or just `notify`) | Also send notifications from this widget (see below). Add it to one widget only |

   A word the widget doesn't know is shown at its bottom (`Unknown: …`).

**App menu.** Run the script in the app to open it. Each item comes back to the menu:

| Item | What it does |
|---|---|
| **Details** | The details page (the same as tapping the widget) |
| **Widget** | **Preview current values** or **Preview sample data** in any home screen or lock screen size; **Make a parameter** (answer three questions, then copy the Parameter or preview it); **Parameter guide** (every Parameter and what it shows) |
| **Notifications** | **Send sample notifications**, and turn **Limit alerts** and **Time reminders** on or off |
| **Settings** | **Server and token**; **Display**: the **Appearance** of every home screen widget and the details page (**Auto** follows the iPhone's Light or Dark setting, or always **Light** or **Dark**) and each provider's icon (with a second set built in); **Saved data**: **Reset saved data**, **Remove all settings** (both ask first) |

iOS decides how often widgets refresh, usually every 15–60 minutes. Countdowns to the reset keep running between refreshes.

**Details:** tap the widget to open a details page in Scriptable: every limit with its reset time, pace, forecast and confidence, the weekly chart, and recent events. On a medium or large widget, each provider's column opens that provider. You can also choose **Details** in the app menu.

**Notifications** (optional):

1. Run the script in the app, choose **Notifications**, then **Send sample notifications** and allow notifications. The samples show each kind for Claude, Codex or both.
2. Add `notify` to the Parameter of **one** widget (for example `notify` or `claude, notify`). Each time that widget refreshes, it:
   - schedules **time reminders** on the iPhone: when a provider at its limit resets, and 15 minutes before a limit is forecast to run out. These ring on time even if the widget isn't refreshed;
   - tells new **limit alerts** from the server (limit reached, reset after a limit, weekly 80%, collection stopped, sign-in required). These arrive on the next refresh, so they can be 15–60 minutes late.
3. Each kind can be turned off under **Notifications**. **Settings** > **Saved data** > **Reset saved data** forgets saved values, scheduled reminders and where the alerts left off.

If the widget can't schedule notifications on your iPhone, use a Shortcuts automation instead: add **Run Script**, choose `Headroom`, and pass `notify` as the parameter. It runs without opening a screen and outputs a short summary.

## 4. Updating and removing

- **Agent:**
  1. Keep a copy of the old package.
  2. Run `install` from the new package; it stops the running agent, replaces the binaries and starts the agent again.
  3. If `install` fails, run `install` from the old package to restore it.
- **Agent removal:** `headroom uninstall` stops the agent and removes the login entry. Then delete `~/.headroom` if you no longer need it, and run `headroom credentials clear` first if you want the token removed from the credential store.
- **Server:** pull the new source, then:
  1. Apply new migrations with `npx wrangler d1 migrations apply headroom --remote -c wrangler.prod.toml`.
  2. Deploy with `npx wrangler deploy -c wrangler.prod.toml`.

  A server and agents of different protocols refuse each other (426): an older agent stops sending and fetching until it is updated, and a newer agent facing an older server waits and checks again hourly. Update the server first, then every PC.

  Apply migrations before deploying. **Exception:** a migration that only drops a table is applied **after** deploying that Worker; its header comment says so.
- **Planned stop** (when a release or a migration's header asks for it, so nothing an older Worker accepted is sent again):
  1. On every PC: stop the agent with the installed version (`headroom stop`). Then, with the `headroom` of the **new, extracted package** (not installed yet; the old version has no such command), run `headroom discard-queue` and check that `headroom status` shows `Push: 0 unsent observations`. A PC that is asleep is handled the same way before it sends again.
  2. Apply the migrations, then deploy the Worker, as above. The new Worker refuses uploads from older agents (426), so one sent before the stop and arriving late isn't saved.
  3. Wait a minute (requests the earlier Worker was still handling finish), then run the one-time cleanup: `npx wrangler d1 execute headroom --remote -c wrangler.prod.toml --file upgrade/after-deploy.sql` (in `packages/worker`). It removes rows the new Worker no longer accepts; speeds and the weekly series are computed again by the next Cron (up to 5 minutes, and an hour for the weekly series), and the widget shows no values until then.
  4. On every PC: run `install` from the new package (it starts the agent).
- **Widget:** update the server first, then close the Scriptable app (swipe it away) and paste the new script over the old one, while no notifying shortcut is running (a newer widget may ask the server for data an older server doesn't serve; an older copy left running could write settings the newer one doesn't expect). Settings are kept.

## 5. Troubleshooting

- **First check:** `headroom status` shows the last error per provider and the send result.
- **Send result says the PC's clock is ahead of or behind the destination's:** the Worker refuses uploads from a PC whose clock is more than 2 minutes off, because it uses the PC's times as they are. Turn on automatic time sync (Windows: Settings > Time & language > Set time automatically; macOS: System Settings > General > Date & Time). Observations the agent had queued when it was refused are dropped (they were stamped by the wrong clock). While refused, the agent doesn't fetch at all and takes no fetch turn, so another PC fetches meanwhile; it checks the clock with a send that carries no values, and once that goes through it fetches again. Every value the agent takes in carries the clock's generation (`clock-epoch.json`), so nothing taken before the refusal is used or sent after it. A send whose answer is lost (a timeout after the request went out) counts as a possible refusal and is followed by such a check; a request that never reached the destination doesn't. Until the clock is trusted again, `headroom status` shows no values (its `Clock:` line says why), and `headroom collect` doesn't fetch or accept an account switch. If the clock state can't be read, it counts as refused the same way. Values stamped by the wrong clock are never sent, also after the clock is fixed.
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
- **`next check ... (another PC holds the fetch turn; checks again then)`:** another PC is fetching the same values, so this PC waits and decides again at that time. Its own values in `snapshot.json` can look old; the widget shows the values the server merges from all PCs. After `own_fetch_min`, this PC asks for a fetch of its own (still not past a rate limit, an access denial or another fetch in progress).
- **`next check ... (couldn't ask the destination for the fetch turn; asks again then)`:** with `[push]` set, the agent fetches only when the server says it may. Check the URL, the token and the send result; if the server is older than the agent, update it.
- **`next check ... (rate limited by the service; every PC waits until then)`:** a service answered that the fetches were too frequent. Every PC waits; nothing needs to be done.
- **`none (access denied by the service; ...)`, or the widget shows `Access denied`:** a service denied access, so every PC stopped fetching that provider. Check the account (sign in again with its CLI if needed). Then, on one PC, run the command that `headroom status` shows (`headroom collect --provider <name> --resume-access <stop>`). It tries once; on success every PC fetches again. If the stop changed meanwhile (another denial), nothing is tried: check again and use the new number. If a safety stop shows too, add `--force` to the same command.
- **`none (the last fetch's result couldn't be checked; ...)`:** a fetch stopped before its result was checked (the PC slept or the agent was stopped), so whether it was refused can't be told; every PC waits for it. Check `headroom status`. After 5 minutes, run the command it shows on that PC (`headroom collect --provider <name> --force --replace <attempt>`). Another attempt ID replaces nothing.
- **Widget shows `Check your credentials`:** the read token is wrong or was revoked.
- **Widget shows `Can't reach the server`:** check the URL, or `ALLOWED_HOST` on the server.
- **No notifications:** check that notifications are allowed for Scriptable, that exactly one widget has `notify`, and the last check time under **Notifications** in the app menu. After the server's database is recreated, choose **Settings** > **Saved data** > **Reset saved data**.
- **Values look old:** `headroom status` shows when the agent last sent. The widget marks old values (for example `31m ago`) and limits whose reset time passed since the last value (`↻`).
