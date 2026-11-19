//! Reads and writes the shared fixture (fixtures/snapshot/) with the Rust types and checks that the JSON matches the TS side.

use headroom::schema::{Snapshot, sendable_scope};
use serde_json::Value;

#[test]
fn v2_basic_roundtrips_exactly() {
    let text = include_str!("../../fixtures/snapshot/v2-basic.json");
    let original: Value = serde_json::from_str(text).unwrap();
    let parsed: Snapshot = serde_json::from_str(text).expect("readable with the Rust types");
    let reserialized = serde_json::to_value(&parsed).unwrap();
    assert_eq!(
        reserialized, original,
        "reading and writing in Rust gives back the same JSON"
    );
}

/// The same upload is read by the Worker's tests (packages/worker/test/worker.test.ts): only the unknown group is left out
#[test]
fn upload_with_an_unknown_group_keeps_the_known_windows() {
    let body: Value = serde_json::from_str(include_str!(
        "../../fixtures/snapshot/upload-unknown-group.json"
    ))
    .unwrap();
    let snapshot: Snapshot = serde_json::from_value(body["snapshot"].clone()).unwrap();
    let sent = snapshot.for_upload();
    let ids: Vec<_> = sent.providers["codex"]
        .windows
        .iter()
        .map(|w| w.id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "seven_day",
            "codex_other_seven_day",
            "codex_bengalfox_five_hour"
        ]
    );
    let observed: Vec<_> = body["observations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["window_id"].as_str().unwrap())
        .filter(|id| sendable_scope(id).is_some())
        .collect();
    assert_eq!(observed, ["seven_day", "codex_bengalfox_five_hour"]);
    assert_eq!(
        sent.providers["claude"],
        snapshot.providers["claude"].for_upload()
    );
}
