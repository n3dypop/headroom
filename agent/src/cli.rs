//! Command dispatch.

use std::collections::BTreeMap;

use crate::agent;
use crate::config::{self, collector_id, headroom_home};
use crate::providers::codex::CodexProvider;
use crate::push::{Credentials, OsCredentialStore, Pusher};
use crate::schema::build_snapshot;
use crate::store::{Logger, read_json};
use crate::time::now_ms;

const HELP: &str = "headroom — background agent that collects Claude / Codex usage limits

Usage:
  headroom agent                          Run in the background (on Windows, use headroomw.exe)
  headroom statusline [--then \"<cmd>\"]    Called from Claude Code's statusLine
  headroom collect [--provider claude|codex] [--force] [--accept-account]
                                          Fetch once and print the result
                                          (--force ignores the interval; neither uses any quota)
  headroom status                         Show the last result and the current state
  headroom credentials set | clear        Save / delete the destination credentials in the OS credential store
                                          (set reads one line from stdin: the Worker token)
  headroom install | uninstall            Register autostart and start / stop and unregister
                                          (install copies the executable to ~/.headroom/bin)
  headroom start | stop                   Start / stop the background agent (stop waits for the current fetch to finish)
  headroom version

State lives in ~/.headroom (override with HEADROOM_HOME).";

pub fn run(args: Vec<String>) -> i32 {
    let home = headroom_home();
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("agent") => agent::run(&home),
        Some("statusline") => crate::statusline::run(rest, &home),
        Some("collect") => collect(rest, &home),
        Some("status") => status(&home),
        Some("credentials") => credentials(rest),
        Some("install") => match config::load(&home) {
            Ok(cfg) => report(crate::install::install(&home, &cfg)),
            Err(e) => {
                eprintln!("{e}");
                2
            }
        },
        Some("uninstall") => report(crate::install::uninstall(&home)),
        Some("stop") => match crate::install::stop(&home, crate::install::STOP_WAIT) {
            Ok(true) => {
                println!("Stopped the background agent");
                0
            }
            Ok(false) => {
                println!("The background agent is not running");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        Some("start") => {
            report(crate::install::start(&home).map(|()| {
                vec!["Started the background agent (autostart was not registered)".into()]
            }))
        }
        Some("version") | Some("--version") | Some("-V") => {
            println!("headroom {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            println!("{HELP}");
            0
        }
        Some(other) => {
            eprintln!("Unknown command: {other}\n\n{HELP}");
            2
        }
    }
}

const COLLECT_USAGE: &str =
    "Usage: headroom collect [--provider claude|codex] [--force] [--accept-account]
  --accept-account requires --provider (name exactly one provider to resume)";

#[derive(Debug, PartialEq, Eq)]
struct CollectArgs {
    provider: Option<&'static str>,
    force: bool,
    accept_account: bool,
}

/// Validates the collect arguments. On invalid input nothing is run.
fn parse_collect_args(args: &[String]) -> Result<CollectArgs, String> {
    let mut out = CollectArgs {
        provider: None,
        force: false,
        accept_account: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--force" => out.force = true,
            "--accept-account" => out.accept_account = true,
            "--provider" => {
                if out.provider.is_some() {
                    return Err("--provider was given twice".into());
                }
                out.provider = Some(match it.next().map(String::as_str) {
                    Some("claude") => "claude",
                    Some("codex") => "codex",
                    Some(other) => return Err(format!("Unknown provider: {other}")),
                    None => return Err("--provider needs a value".into()),
                });
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    if out.accept_account && out.provider.is_none() {
        return Err("--accept-account requires --provider claude or --provider codex".into());
    }
    Ok(out)
}

fn collect(args: &[String], home: &std::path::Path) -> i32 {
    let parsed = match parse_collect_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "{e}
{COLLECT_USAGE}"
            );
            return 2;
        }
    };
    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let CollectArgs {
        provider: only,
        force,
        accept_account,
    } = parsed;
    let log = Logger::stderr();
    let mut results = BTreeMap::new();
    for mut p in agent::make_providers(home, &cfg, &log) {
        if only.is_some_and(|o| o != p.id()) {
            continue;
        }
        // Resume a provider that stopped on an account switch, using the new account (only the one named)
        if accept_account {
            p.accept_account();
        }
        let snap = p.collect(now_ms(), force);
        results.insert(p.id().to_string(), snap);
    }
    let collector = collector_id(&cfg);
    let now = now_ms();
    if only.is_none()
        && let Err(e) = agent::write_snapshot(home, &results, now, &collector)
    {
        eprintln!("Failed to write snapshot.json: {e}");
    }
    let snapshot = build_snapshot(results, now, &collector);
    println!(
        "{}",
        serde_json::to_string_pretty(&snapshot).unwrap_or_default()
    );
    0
}

/// Shown when `credentials set` is typed directly at a terminal (refused, because the input would show on screen)
pub const CREDENTIALS_TTY_HINT: &str = "Direct input from a terminal is not accepted, so the token never shows on screen. Pipe it in from a hidden prompt:\n  PowerShell: Read-Host -MaskInput 'Worker token' | headroom credentials set\n  macOS (zsh): read -rs 'T?Worker token: ' && printf '%s\\n' \"$T\" | headroom credentials set; unset T";

/// Credentials are read from stdin and never written to the screen, logs or files. Direct input from a terminal is
/// refused because the typed characters would be echoed (no extra dependency to turn off echo per OS; pipe it in instead)
fn credentials(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("set") => {
            if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                eprintln!("{CREDENTIALS_TTY_HINT}");
                return 2;
            }
            let mut lines = std::io::stdin().lines().map_while(Result::ok);
            let c = Credentials {
                token: lines.next().unwrap_or_default().trim().to_string(),
            };
            if c.token.len() < 16 {
                eprintln!("The first line must be the Worker token");
                return 2;
            }
            match OsCredentialStore::save(&c) {
                Ok(()) => {
                    println!("Saved (Worker token)");
                    0
                }
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        Some("clear") => match OsCredentialStore::clear() {
            Ok(()) => {
                println!("Cleared");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("Usage: headroom credentials set | clear");
            2
        }
    }
}

fn report(r: Result<Vec<String>, String>) -> i32 {
    match r {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn status(home: &std::path::Path) -> i32 {
    println!("HEADROOM_HOME: {}", home.display());
    println!(
        "Agent: {} / Autostart: {}",
        if crate::install::agent_running(home) {
            "running"
        } else {
            "stopped"
        },
        if crate::install::registered() {
            "registered"
        } else {
            "not registered"
        }
    );
    match read_json::<serde_json::Value>(&home.join("snapshot.json")) {
        Some(v) => println!(
            "snapshot.json:\n{}",
            serde_json::to_string_pretty(&v).unwrap_or_default()
        ),
        None => println!("snapshot.json: not yet"),
    }
    if let Some(v) = read_json::<serde_json::Value>(&home.join("state-claude.json")) {
        println!(
            "claude: {} consecutive failures / last error {}",
            v["failures"],
            v["last_error"].as_str().unwrap_or("none")
        );
    }
    if let Ok(cfg) = config::load(home)
        && let Some(line) = CodexProvider::status_line(home, &cfg.codex, now_ms())
    {
        println!("{line}");
    }
    match Pusher::status_line(home) {
        Some(line) => println!("{line}"),
        None => {
            println!("Push: not yet (set url under [push] in config.toml and the agent will send)")
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn accept_account_requires_a_valid_provider() {
        assert_eq!(
            parse_collect_args(&args(&["--provider", "codex", "--accept-account"])),
            Ok(CollectArgs {
                provider: Some("codex"),
                force: false,
                accept_account: true
            })
        );
        assert!(
            parse_collect_args(&args(&["--accept-account"])).is_err(),
            "omitting the provider is rejected"
        );
        assert!(parse_collect_args(&args(&["--provider", "claud", "--accept-account"])).is_err());
        assert!(parse_collect_args(&args(&["--provider"])).is_err());
        assert!(
            parse_collect_args(&args(&["--provider", "claude", "--provider", "codex"])).is_err()
        );
        assert!(
            parse_collect_args(&args(&["--accept"])).is_err(),
            "unknown arguments are rejected"
        );
        assert_eq!(
            parse_collect_args(&args(&["--force"])),
            Ok(CollectArgs {
                provider: None,
                force: true,
                accept_account: false
            })
        );
    }

    #[test]
    fn invalid_collect_args_change_no_provider_state() {
        let home =
            std::env::temp_dir().join(format!("headroom-collect-args-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(collect(&args(&["--accept-account"]), &home), 2);
        assert!(!home.join("state-claude.json").exists());
        assert!(!home.join("state-codex.json").exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
