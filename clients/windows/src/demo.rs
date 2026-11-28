//! The sample the client shows until it is connected (or when chosen in Settings): the widget's "three" demo (Codex, Claude and
//! Gemini on an ordinary day), built the way the widget's demoResult builds it, relative to now.

use serde_json::{json, Map, Value};

const MINUTE: f64 = 60_000.0;

#[derive(Default)]
struct W {
    scope: Option<&'static str>,
    recent: Option<f64>,
    rate: Option<f64>,
    resets: Option<Option<f64>>,
    detail: bool,
}

fn at(now: f64, minutes: f64) -> String {
    jiff::Timestamp::from_millisecond((now + minutes * MINUTE) as i64)
        .map(|t| format!("{t:.3}"))
        .unwrap_or_default()
}

fn win(now: f64, id: &str, used: f64, o: W) -> Value {
    let five = id.contains("five_hour");
    let resets = match o.resets {
        Some(None) => Value::Null,
        Some(Some(m)) => Value::String(at(now, m)),
        None => Value::String(at(now, if five { 180.0 } else { 3.0 * 1440.0 })),
    };
    json!({
        "id": id, "label": id, "scope": o.scope, "used_percent": used,
        "recent_consumed_percent": o.recent, "recent_quality": if o.recent.is_some() { "exact" } else { "unknown" },
        "recent_minutes": if five { 60 } else { 1440 }, "confidence": "high", "fetched_at": at(now, -1.0), "resets_at": resets,
        "eta_at": null, "reset_first": null, "eta_minutes": null, "rate_15m": null,
        "rate_60m": o.rate, "rate_24h": o.rate, "rate_pace": o.rate.unwrap_or(0.0), "detail_only": o.detail,
    })
}

fn provider(plan: &str, collector: &str, windows: Vec<Value>) -> Value {
    let ids = |main: bool| {
        windows
            .iter()
            .filter(|w| !main || w["scope"].is_null())
            .map(|w| w["id"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut map = Map::new();
    for w in &windows {
        map.insert(w["id"].as_str().unwrap_or_default().to_string(), w.clone());
    }
    json!({
        "status": "ok", "plan": plan, "error_code": null, "collector": collector,
        "main_window_ids": ids(true), "window_ids": ids(false), "windows": map,
    })
}

fn r(recent: f64, rate: f64) -> W {
    W {
        recent: Some(recent),
        rate: Some(rate),
        ..W::default()
    }
}

/** The sample view at `now` (milliseconds), in the server's shape */
pub fn body(now: f64) -> Value {
    let claude = provider(
        "max",
        "desktop",
        vec![
            win(now, "five_hour", 35.0, r(6.0, 4.0)),
            win(now, "seven_day", 22.0, r(3.0, 0.4)),
            win(
                now,
                "seven_day_fable",
                10.0,
                W {
                    scope: Some("Fable"),
                    ..W::default()
                },
            ),
        ],
    );
    let codex = provider(
        "plus",
        "laptop",
        vec![
            win(now, "five_hour", 20.0, r(2.0, 3.0)),
            win(now, "seven_day", 41.0, r(5.0, 0.5)),
        ],
    );
    let partner = |id, used| {
        win(
            now,
            id,
            used,
            W {
                scope: Some("Claude and GPT"),
                detail: true,
                ..W::default()
            },
        )
    };
    let gemini = provider(
        "pro",
        "desktop",
        vec![
            win(now, "five_hour", 28.0, r(4.0, 3.0)),
            win(now, "seven_day", 33.0, r(4.0, 0.4)),
            win(
                now,
                "seven_day_argon",
                100.0,
                W {
                    scope: Some("Argon"),
                    resets: Some(Some(2.0 * 1440.0)),
                    ..W::default()
                },
            ),
            partner("partner_five_hour", 8.0),
            partner("partner_seven_day", 5.0),
        ],
    );
    json!({
        "view_version": 1, "data_version": 1, "boundaries": { "claude": "#0", "codex": "#0", "gemini": "#0" },
        "claude": claude, "codex": codex, "gemini": gemini,
    })
}
