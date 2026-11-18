//! State file read/write, shared backoff calculation, and a simple logger.

use serde::{Serialize, de::DeserializeOwned};
use std::io::Write;
use std::path::Path;

use crate::time::{MINUTE_MS, iso_from_ms, now_ms};

/// Reads JSON. None if missing or corrupt (only state that can be rebuilt is stored).
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Writes to a temp file and then replaces the target (so readers never see a partial write).
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Wait time by failure count: base, 2×base, 4×base … up to 60 minutes.
pub fn backoff_ms(base_ms: i64, failures: u32) -> i64 {
    let factor = 1i64 << failures.min(10);
    base_ms
        .saturating_mul(factor)
        .min(60 * MINUTE_MS)
        .max(base_ms.min(60 * MINUTE_MS))
}

/// Send sequence number: `max(previous + 1, current time in ms)`. Keeps growing if the clock goes back, and starts from the current time if state is lost.
/// The destination replaces each PC's latest value by this number (same rule as `nextSendSeq` in `packages/core/src/ingest.ts`)
pub fn next_send_seq(last: Option<i64>, now_ms: i64) -> i64 {
    last.unwrap_or(0).saturating_add(1).max(now_ms)
}

/// FNV-1a 64-bit, a hash so account identifiers are never stored as is (not for cryptography).
pub fn fnv1a_hex(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            h ^= 0x1f;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// Simple log rotated as 3 generations of 1 MB. Never write tokens, IDs or email addresses.
#[derive(Clone)]
pub struct Logger {
    path: Option<std::path::PathBuf>,
}

impl Logger {
    pub fn stderr() -> Self {
        Self { path: None }
    }

    pub fn file(home: &Path) -> Self {
        Self {
            path: Some(home.join("logs").join("agent.log")),
        }
    }

    pub fn log(&self, msg: &str) {
        let line = format!("{} {msg}\n", iso_from_ms(now_ms()));
        match &self.path {
            None => eprint!("{line}"),
            Some(path) => {
                let _ = self.append(path, &line);
            }
        }
    }

    fn append(&self, path: &Path, line: &str) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if std::fs::metadata(path)
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false)
        {
            for i in (1..3).rev() {
                let _ = std::fs::rename(
                    path.with_extension(format!("log.{i}")),
                    path.with_extension(format!("log.{}", i + 1)),
                );
            }
            let _ = std::fs::rename(path, path.with_extension("log.1"));
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(line.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        let base = 10 * MINUTE_MS;
        assert_eq!(backoff_ms(base, 0), base);
        assert_eq!(backoff_ms(base, 1), 2 * base);
        assert_eq!(backoff_ms(base, 2), 4 * base);
        assert_eq!(backoff_ms(base, 3), 60 * MINUTE_MS);
        assert_eq!(backoff_ms(base, 30), 60 * MINUTE_MS);
    }

    #[test]
    fn hash_is_stable_and_separates_parts() {
        assert_eq!(fnv1a_hex(&["a", "b"]), fnv1a_hex(&["a", "b"]));
        assert_ne!(fnv1a_hex(&["ab", ""]), fnv1a_hex(&["a", "b"]));
    }
}

#[cfg(test)]
mod send_seq_tests {
    use super::next_send_seq;

    #[test]
    fn send_seq_grows_even_when_the_clock_goes_back() {
        let first = next_send_seq(None, 1_000);
        assert_eq!(first, 1_000);
        let after_clock_fix = next_send_seq(Some(first), 400);
        assert_eq!(after_clock_fix, 1_001);
        assert_eq!(next_send_seq(Some(after_clock_fix), 5_000), 5_000);
    }
}
