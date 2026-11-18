//! Reads and writes the shared fixture (fixtures/snapshot/) with the Rust types and checks that the JSON matches the TS side.

use headroom::schema::Snapshot;
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
