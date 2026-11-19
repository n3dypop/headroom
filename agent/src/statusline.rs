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

/// Values captured from statusLine (the shape of ~/.headroom/claude-statusline.json).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Capture {
    /// When these rate_limits were first observed (ISO8601)
    pub captured_at: String,
    #[serde(default)]
    pub captured_at_ms: i64,
    pub rate_limits: Value,
}

pub fn run(args: &[String], home: &Path) -> i32 {
    let then_cmd = args
        .windows(2)
        .find(|w| w[0] == "--then")
        .map(|w| w[1].clone());

    let mut input = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut input);
    let parsed: Option<Value> = serde_json::from_slice(&input).ok();

    // rate_limits is absent until the session's first API response. When absent, keep the previous capture.
    if let Some(rl) = parsed.as_ref().and_then(|v| v.get("rate_limits")) {
        let _ = save_capture(home, rl, now_ms());
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

/// Stores only `capture_fields`. Don't write if nothing is left or the value is unchanged (keeps captured_at as "when this value appeared").
pub fn save_capture(home: &Path, rate_limits: &Value, now: i64) -> std::io::Result<bool> {
    let Some(rate_limits) = capture_fields(rate_limits) else {
        return Ok(false);
    };
    let path = home.join(CAPTURE_FILE);
    if let Some(prev) = read_json::<Capture>(&path)
        && prev.rate_limits == rate_limits
    {
        return Ok(false);
    }
    let cap = Capture {
        captured_at: iso_from_ms(now),
        captured_at_ms: now,
        rate_limits,
    };
    write_json_atomic(&path, &cap)?;
    Ok(true)
}

/// Read the capture and return (observed time ms, windows).
pub fn read_capture(home: &Path) -> Option<(i64, Vec<UsageWindow>)> {
    let cap: Capture = read_json(&home.join(CAPTURE_FILE))?;
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
        d
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
