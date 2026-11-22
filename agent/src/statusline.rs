//! `headroom statusline`: called from Claude Code's statusLine.
//! Called on every render, so speed comes first. Whatever fails, it prints one line and exits.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::providers::claude::is_claude_window;
use crate::schema::{UsageWindow, WindowKind, known_scope, make_window};
use crate::store::{read_json, write_json_atomic};
use crate::time::{iso_from_ms, ms_from_epoch, now_ms};

pub const CAPTURE_FILE: &str = "claude-statusline.json";
/// Claude's acceptance generation (a number), raised by each acceptance of an account switch under the writers' lock. A writer notes it
/// before reading its input and saves only if it is unchanged under the lock: an input of the account before is never saved after
const CLAUDE_GEN_FILE: &str = "claude-statusline.gen";
const CLAUDE_LOCK_FILE: &str = "claude-statusline.lock";
const CLAUDE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

/// Claude's acceptance generation now (0: none yet, or unreadable: a writer then passes over its input after an acceptance)
pub fn read_claude_gen(home: &Path) -> u64 {
    std::fs::read_to_string(home.join(CLAUDE_GEN_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Claude's acceptance generation file written again when it isn't a number (store::repair_gen_file)
pub fn repair_claude_gen(home: &Path, known: u64) -> bool {
    crate::store::repair_gen_file(home, CLAUDE_GEN_FILE, CLAUDE_LOCK_FILE, known)
}

/// Raises Claude's acceptance generation under the writers' lock (held until the acceptance is saved, by the returned lock). The
/// generation now, or an error (the acceptance isn't made)
pub fn raise_claude_gen(
    home: &Path,
    at_least: u64,
) -> std::io::Result<(u64, crate::store::FileLock)> {
    let lock = crate::store::FileLock::acquire(home, CLAUDE_LOCK_FILE, CLAUDE_LOCK_WAIT * 10)
        .ok_or_else(|| std::io::Error::other("the statusLine record is locked"))?;
    let next = read_claude_gen(home).max(at_least) + 1;
    std::fs::write(home.join(CLAUDE_GEN_FILE), next.to_string())?;
    Ok((next, lock))
}

/// Values captured from statusLine (the shape of ~/.headroom/claude-statusline.json).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Capture {
    /// When these rate_limits were first observed (ISO8601)
    pub captured_at: String,
    #[serde(default)]
    pub captured_at_ms: i64,
    pub rate_limits: Value,
    /// Clock epoch read before the input was (clock.rs): used only while that epoch is current and trusted. None when it couldn't be
    /// read (never used)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// Claude's acceptance generation read before the input was: a record of one before the last acceptance is never used
    #[serde(default)]
    pub accept_gen: u64,
}

pub fn run(args: &[String], home: &Path) -> i32 {
    let then_cmd = args
        .windows(2)
        .find(|w| w[0] == "--then")
        .map(|w| w[1].clone());
    if args.iter().any(|a| a == "--gemini") {
        return run_gemini(home, then_cmd);
    }

    // The clock epoch and the acceptance generation first: a value read under them and saved late carries what it came in
    let epoch = crate::clock::usable_epoch(home);
    let accept_gen = read_claude_gen(home);
    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    let parsed: Option<Value> = serde_json::from_slice(&input).ok();

    // rate_limits is absent until the session's first API response. When absent, keep the previous capture.
    if let Some(rl) = parsed.as_ref().and_then(|v| v.get("rate_limits")) {
        let _ = save_capture_gen(home, rl, now_ms(), epoch, accept_gen);
    }

    let out = match then_cmd {
        Some(cmd) => run_passthrough(&cmd, &input).unwrap_or_else(|| format_line(parsed.as_ref())),
        None => format_line(parsed.as_ref()),
    };
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(out.as_bytes());
    if !out.ends_with('\n') {
        let _ = stdout.write_all(b"\n");
    }
    0
}

/// `headroom statusline --gemini`: called from the Antigravity CLI's statusLine. Keeps a hash of the account's email and the plan (never
/// the email), then prints what the user's own command prints (`--then`), or nothing (Antigravity's own status line stays with
/// `stack_with_default`). Always exits 0, so Antigravity never turns the command off
fn run_gemini(home: &Path, then_cmd: Option<String>) -> i32 {
    use crate::providers::gemini::{capture_from_input, read_accept_gen, save_capture};
    // Both read before the input: an acceptance after this point makes the input one of the time before (not saved)
    let epoch = crate::clock::usable_epoch(home);
    let accept_gen = read_accept_gen(home);
    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    if let Some(mut cap) = serde_json::from_slice::<Value>(&input)
        .ok()
        .and_then(|v| capture_from_input(&v, now_ms(), epoch))
    {
        cap.accept_gen = accept_gen;
        let _ = save_capture(home, &cap);
    }
    if let Some(out) = then_cmd.and_then(|cmd| run_passthrough(&cmd, &input)) {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(out.as_bytes());
    }
    0
}

/// The part of statusLine's rate_limits that is kept: entries named like a Claude window (`is_claude_window`) and only their `used_percentage` and
/// `resets_at` numbers. Other fields Claude Code may add are not stored. None if nothing remains
pub fn capture_fields(rate_limits: &Value) -> Option<Value> {
    let kept: serde_json::Map<String, Value> = rate_limits
        .as_object()?
        .iter()
        .filter(|(id, _)| is_claude_window(id))
        .filter_map(|(id, w)| {
            let pct = w.get("used_percentage").filter(|v| v.is_number())?;
            let mut out = serde_json::Map::new();
            out.insert("used_percentage".into(), pct.clone());
            if let Some(r) = w.get("resets_at").filter(|v| v.is_number()) {
                out.insert("resets_at".into(), r.clone());
            }
            Some((id.clone(), Value::Object(out)))
        })
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

/// Stores only `capture_fields`, under the clock epoch usable now
pub fn save_capture(home: &Path, rate_limits: &Value, now: i64) -> std::io::Result<bool> {
    save_capture_in(home, rate_limits, now, crate::clock::usable_epoch(home))
}

/// save_capture_in under the writers' lock, only if the acceptance generation read before the input is still the one now (an input
/// read before an acceptance is of the account before: not saved)
pub fn save_capture_gen(
    home: &Path,
    rate_limits: &Value,
    now: i64,
    epoch: Option<u64>,
    accept_gen: u64,
) -> std::io::Result<bool> {
    let _lock = crate::store::FileLock::acquire(home, CLAUDE_LOCK_FILE, CLAUDE_LOCK_WAIT)
        .ok_or_else(|| std::io::Error::other("the statusLine record is locked"))?;
    if read_claude_gen(home) != accept_gen {
        return Ok(false);
    }
    save_capture_in(home, rate_limits, now, epoch)
}

/// Stores only `capture_fields`, with the clock epoch read before the input. Don't write if nothing is left or the value and its epoch are
/// unchanged (keeps captured_at as "when this value appeared"; the same value in a new epoch is a new one)
pub fn save_capture_in(
    home: &Path,
    rate_limits: &Value,
    now: i64,
    epoch: Option<u64>,
) -> std::io::Result<bool> {
    let Some(rate_limits) = capture_fields(rate_limits) else {
        return Ok(false);
    };
    let path = home.join(CAPTURE_FILE);
    let accept_gen = read_claude_gen(home);
    if let Some(prev) = read_json::<Capture>(&path)
        && prev.rate_limits == rate_limits
        && prev.epoch == epoch
        && prev.accept_gen == accept_gen
    {
        return Ok(false);
    }
    let cap = Capture {
        captured_at: iso_from_ms(now),
        captured_at_ms: now,
        rate_limits,
        epoch,
        accept_gen,
    };
    write_json_atomic(&path, &cap)?;
    Ok(true)
}

/// Read the capture and return (observed time ms, windows), if it was taken in the clock epoch usable now
pub fn read_capture(home: &Path) -> Option<(i64, Vec<UsageWindow>)> {
    read_capture_in(home, crate::clock::usable_epoch(home))
}

/// Read the capture, if it was taken in `epoch` (None: none is used)
pub fn read_capture_in(home: &Path, epoch: Option<u64>) -> Option<(i64, Vec<UsageWindow>)> {
    read_capture_since(home, epoch, 0)
}

/// read_capture_in, only of acceptance generation `min_gen` or later
pub fn read_capture_since(
    home: &Path,
    epoch: Option<u64>,
    min_gen: u64,
) -> Option<(i64, Vec<UsageWindow>)> {
    let epoch = epoch?;
    let bytes = std::fs::read(home.join(CAPTURE_FILE)).ok()?;
    let cap: Capture = serde_json::from_slice(&bytes).ok()?;
    if cap.epoch != Some(epoch) || cap.accept_gen < min_gen {
        return None;
    }
    capture_from(&bytes)
}

/// The observed time of the saved value and the clock epoch it was taken in (None without one). Err when the file exists but can't be
/// read (an I/O error: a later read may still find the value)
pub fn capture_at(home: &Path) -> std::io::Result<Option<(i64, Option<u64>)>> {
    match std::fs::read(home.join(CAPTURE_FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
        Ok(bytes) => {
            let epoch = serde_json::from_slice::<Capture>(&bytes)
                .ok()
                .and_then(|c| c.epoch);
            Ok(capture_from(&bytes).map(|(at, _)| (at, epoch)))
        }
    }
}

fn capture_from(bytes: &[u8]) -> Option<(i64, Vec<UsageWindow>)> {
    let cap: Capture = serde_json::from_slice(bytes).ok()?;
    let at = if cap.captured_at_ms > 0 {
        cap.captured_at_ms
    } else {
        return None;
    };
    let windows = windows_from_rate_limits(&cap.rate_limits);
    (!windows.is_empty()).then_some((at, windows))
}

/// statusLine input rate_limits -> windows. used_percentage is 0-100, resets_at is epoch seconds.
pub fn windows_from_rate_limits(rl: &Value) -> Vec<UsageWindow> {
    let Some(obj) = rl.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .filter(|(id, _)| is_claude_window(id))
        .filter_map(|(id, w)| {
            let pct = w.get("used_percentage")?.as_f64()?;
            let resets = w
                .get("resets_at")
                .and_then(Value::as_f64)
                .and_then(ms_from_epoch);
            let mut window = make_window(id, pct, resets);
            // A per-model weekly window carries its model, as from /usage (so it never counts as the overall limit)
            if let Some(model) = id.strip_prefix("seven_day_") {
                window.scope = known_scope(model).map(str::to_string);
                window.kind = WindowKind::Weekly;
                if window.label == *id {
                    window.label = format!("Weekly {}", window.scope.as_deref().unwrap_or(model));
                }
            }
            Some(window)
        })
        .collect()
}

pub fn format_line(input: Option<&Value>) -> String {
    let mut parts = Vec::new();
    if let Some(name) = input
        .and_then(|v| v.pointer("/model/display_name"))
        .and_then(Value::as_str)
    {
        parts.push(format!("[{name}]"));
    }
    for (key, label) in [("five_hour", "5h"), ("seven_day", "Weekly")] {
        let pct = input
            .and_then(|v| v.get("rate_limits"))
            .and_then(|r| r.get(key))
            .and_then(|w| w.get("used_percentage"))
            .and_then(Value::as_f64);
        if let Some(p) = pct {
            parts.push(format!("{label} {}%", p.round() as i64));
        }
    }
    parts.join(" ")
}

/// Pass stdin unchanged to the existing statusLine command and return its output.
fn run_passthrough(cmd: &str, input: &[u8]) -> Option<String> {
    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", cmd]);
        c
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    let out = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_home(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("headroom-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        crate::test_util::trust_clock(&d);
        d
    }

    /// The agent records a refusal of the clock and then lifts it (two new epochs)
    fn refuse_and_lift(home: &std::path::Path) {
        for trusted in [false, true] {
            let _lock = crate::clock::hold_clock_lock(home).unwrap();
            let state = crate::clock::ensure_locked(home, || Ok(false)).unwrap();
            crate::clock::advance_locked(home, &state, trusted).unwrap();
        }
    }

    #[test]
    fn value_read_before_a_refusal_and_its_lifting_but_saved_after_is_never_used() {
        let home = temp_home("capture-epoch");
        let rl = json!({"five_hour": {"used_percentage": 5, "resets_at": 1}});
        // the epoch is read before the input; the save comes after the agent refused and lifted the clock
        let read_under = crate::clock::usable_epoch(&home);
        refuse_and_lift(&home);
        assert!(save_capture_in(&home, &rl, 1_000, read_under).unwrap());
        assert!(read_capture(&home).is_none(), "of the epoch before");
        // the control: the same value read under the new epoch is a new one, and used
        assert!(save_capture(&home, &rl, 2_000).unwrap());
        assert_eq!(read_capture(&home).unwrap().0, 2_000);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_input_read_before_an_acceptance_is_never_saved_after_it() {
        let home = temp_home("capture-gen");
        let rl = json!({"five_hour": {"used_percentage": 5, "resets_at": 1}});
        let epoch = crate::clock::usable_epoch(&home);
        // a writer reads the generation, then its input; an acceptance raises the generation meanwhile
        let before = read_claude_gen(&home);
        let (raised, writers) = raise_claude_gen(&home, 0).unwrap();
        assert_eq!(raised, before + 1);
        // while the acceptance holds the writers' lock, no writer saves
        assert!(save_capture_gen(&home, &rl, 1_000, epoch, raised).is_err());
        drop(writers);
        assert!(!save_capture_gen(&home, &rl, 1_000, epoch, before).unwrap());
        assert!(read_capture(&home).is_none());
        // the control: one read after it is saved, and read by the state accepted in it
        assert!(save_capture_gen(&home, &rl, 2_000, epoch, raised).unwrap());
        assert_eq!(read_capture_since(&home, epoch, raised).unwrap().0, 2_000);
        assert!(read_capture_since(&home, epoch, raised + 1).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_broken_generation_file_is_written_again_with_the_generation_known() {
        let home = temp_home("gen-broken");
        let epoch = crate::clock::usable_epoch(&home);
        let rl = json!({"five_hour": {"used_percentage": 5, "resets_at": 1}});
        let (raised, lock) = raise_claude_gen(&home, 0).unwrap();
        drop(lock);
        std::fs::write(home.join(CLAUDE_GEN_FILE), b"x").unwrap();
        // a writer meanwhile reads 0: its record is of a generation before, never taken
        assert!(save_capture_gen(&home, &rl, 1_000, epoch, read_claude_gen(&home)).unwrap());
        assert!(read_capture_since(&home, epoch, raised).is_none());
        // the reader writes it again; the next input is taken
        assert!(repair_claude_gen(&home, raised));
        assert_eq!(read_claude_gen(&home), raised);
        assert!(!repair_claude_gen(&home, raised), "once");
        assert!(
            save_capture_gen(
                &home,
                &json!({"five_hour": {"used_percentage": 6, "resets_at": 1}}),
                2_000,
                epoch,
                read_claude_gen(&home)
            )
            .unwrap()
        );
        assert_eq!(read_capture_since(&home, epoch, raised).unwrap().0, 2_000);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn capture_only_rewrites_on_change() {
        let home = temp_home("capture");
        let rl = json!({"five_hour": {"used_percentage": 1, "resets_at": 1}});
        assert!(save_capture(&home, &rl, 1_000).unwrap());
        assert!(!save_capture(&home, &rl, 2_000).unwrap());
        assert_eq!(read_capture(&home).unwrap().0, 1_000);
        assert!(
            save_capture(
                &home,
                &json!({"five_hour": {"used_percentage": 2, "resets_at": 1}}),
                3_000
            )
            .unwrap()
        );
        assert_eq!(read_capture(&home).unwrap().0, 3_000);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn capture_keeps_only_window_numbers() {
        let home = crate::test_util::TempHome::new("headroom-test-capture-fields");
        let rl = json!({
            "five_hour": {"used_percentage": 3, "resets_at": 1, "org": "Acme Corp"},
            "Acme Corp": {"used_percentage": 9},
            "acme_corp": {"used_percentage": 9},
            "seven_day_opus_4": {"used_percentage": 9},
            "extra_usage": {"used_percentage": 100},
            "seven_day": {"used_percentage": "9"},
            "note": "Acme Corp"
        });
        assert!(save_capture(&home, &rl, 1_000).unwrap());
        let text = std::fs::read_to_string(home.join(CAPTURE_FILE)).unwrap();
        assert!(!text.to_ascii_lowercase().contains("acme"), "{text}");
        assert!(
            !text.contains("opus_4") && !text.contains("extra_usage"),
            "{text}"
        );
        let saved: Capture = serde_json::from_str(&text).unwrap();
        assert_eq!(
            saved.rate_limits,
            json!({"five_hour": {"used_percentage": 3, "resets_at": 1}})
        );
        assert!(!save_capture(&home, &json!({"note": "x"}), 2_000).unwrap());
    }

    #[test]
    fn model_weeks_from_statusline_carry_their_model() {
        let ws = windows_from_rate_limits(&json!({
            "seven_day": {"used_percentage": 20},
            "seven_day_opus": {"used_percentage": 100},
            "seven_day_fable": {"used_percentage": 5}
        }));
        let opus = ws.iter().find(|w| w.id == "seven_day_opus").unwrap();
        assert_eq!(
            (opus.scope.as_deref(), opus.kind),
            (Some("Opus"), WindowKind::Weekly)
        );
        let fable = ws.iter().find(|w| w.id == "seven_day_fable").unwrap();
        assert_eq!(
            (fable.scope.as_deref(), fable.label.as_str()),
            (Some("Fable"), "Weekly Fable")
        );
        assert_eq!(ws.iter().find(|w| w.id == "seven_day").unwrap().scope, None);
    }

    #[test]
    fn statusline_input_to_windows_and_line() {
        let input: Value = serde_json::from_str(include_str!(
            "../../fixtures/claude/statusline-input.sample.json"
        ))
        .unwrap();
        let ws = windows_from_rate_limits(&input["rate_limits"]);
        let five = ws.iter().find(|w| w.id == "five_hour").unwrap();
        assert_eq!(five.used_percent, 23.5);
        assert_eq!(five.resets_at.as_deref(), Some("2025-11-16T15:00:00.000Z"));
        assert_eq!(format_line(Some(&input)), "[Opus 5.5] 5h 24% Weekly 41%");
        assert_eq!(format_line(None), "");
    }
}
