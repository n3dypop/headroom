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
    #[test]
    fn the_schedule_seed_is_a_random_secret_made_once_per_pc() {
        let a = crate::test_util::TempHome::new("headroom-store-seed-a");
        let b = crate::test_util::TempHome::new("headroom-store-seed-b");
        // read only: none made, the PC's name
        assert_eq!(schedule_seed(&a, "win", false), "win");
        assert!(!a.join(SCHEDULE_SEED_FILE).exists());
        let seed = schedule_seed(&a, "win", true);
        assert_eq!(seed.len(), 32);
        assert!(seed.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            std::fs::read_to_string(a.join(SCHEDULE_SEED_FILE)).unwrap(),
            seed
        );
        // kept: the same for every later process and for a read only one
        assert_eq!(schedule_seed(&a, "win", true), seed);
        assert_eq!(schedule_seed(&a, "win", false), seed);
        // another PC of the same name gets its own
        assert_ne!(schedule_seed(&b, "win", true), seed);
        // one that isn't a seed is made again; one that can't be made gives the name
        std::fs::write(a.join(SCHEDULE_SEED_FILE), "x").unwrap();
        assert_eq!(schedule_seed(&a, "win", false), "win");
        let again = schedule_seed(&a, "win", true);
        assert!(again.len() == 32 && again != seed);
        std::fs::remove_file(a.join(SCHEDULE_SEED_FILE)).unwrap();
        std::fs::create_dir(a.join(SCHEDULE_SEED_FILE)).unwrap();
        assert_eq!(schedule_seed(&a, "win", true), "win");
    }

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

/// A file lock in the Headroom folder (a provider's state; a statusLine record and its writers). The OS
/// releases it when the file is closed
pub struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    pub fn acquire(home: &Path, name: &str, wait: std::time::Duration) -> Option<Self> {
        std::fs::create_dir_all(home).ok()?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(home.join(name))
            .ok()?;
        let deadline = std::time::Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Some(Self { _file: file }),
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                Err(_) => return None,
            }
        }
    }
}

/// A statusLine acceptance generation file that isn't a number (written over, cut) or is gone: written again with the generation
/// the caller's state was accepted in, under the writers' lock, so new inputs are taken again (a writer reads 0 from it meanwhile, and
/// its records are of a generation before). true if it was written. Common to every provider that keeps one
pub fn repair_gen_file(
    home: &std::path::Path,
    gen_file: &str,
    lock_file: &str,
    known: u64,
) -> bool {
    let path = home.join(gen_file);
    let broken = |path: &std::path::Path| match std::fs::read_to_string(path) {
        Ok(text) => text.trim().parse::<u64>().is_err(),
        // Gone after an acceptance (the caller's state knows one), or can't be read
        Err(_) => true,
    };
    if known == 0 || !broken(&path) {
        return false;
    }
    let Some(_lock) = FileLock::acquire(home, lock_file, std::time::Duration::from_millis(500))
    else {
        return false;
    };
    broken(&path) && std::fs::write(&path, known.to_string()).is_ok()
}

/// The account a provider's state knows (its hash, this PC only: never sent), kept beside the state, so a state that is gone
/// (deleted, lost) starts again knowing it: another account seen then is a switch to accept, not the first one. Common to
/// every provider that tells accounts apart
fn known_account_path(home: &std::path::Path, provider: &str) -> std::path::PathBuf {
    home.join(format!("account-{provider}.txt"))
}

/// Keeps the account hash the state just saved (written only when it changed)
pub fn keep_account(home: &std::path::Path, provider: &str, hash: Option<&str>) {
    let Some(hash) = hash else {
        return;
    };
    let path = known_account_path(home, provider);
    if std::fs::read_to_string(&path).is_ok_and(|kept| kept.trim() == hash) {
        return;
    }
    let _ = std::fs::write(path, hash);
}

/// The account hash kept for a state that is gone (None: none kept)
pub fn known_account(home: &std::path::Path, provider: &str) -> Option<String> {
    std::fs::read_to_string(known_account_path(home, provider))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// This PC's schedule seed (in the Headroom folder; never sent or logged)
pub const SCHEDULE_SEED_FILE: &str = "schedule-seed.txt";

/// The seed that spreads this PC's fetch times (the jitter) and marks its attempt ids: a random secret made once on this PC (with
/// `create`) and kept in the Headroom folder, so the next fetch time can't be worked out from the public source and the PC's name. A
/// seed that can't be read or made gives `fallback` (the PC's name): every process of this PC still plans alike
pub fn schedule_seed(home: &Path, fallback: &str, create: bool) -> String {
    let path = home.join(SCHEDULE_SEED_FILE);
    let read = || {
        std::fs::read_to_string(&path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    };
    if let Some(seed) = read() {
        return seed;
    }
    if !create {
        return fallback.to_string();
    }
    let seed = random_hex();
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let saved = std::fs::create_dir_all(home)
        .and_then(|_| std::fs::write(&tmp, &seed))
        .and_then(|_| std::fs::rename(&tmp, &path));
    let _ = std::fs::remove_file(&tmp);
    // Read back: what is kept is what every process uses
    match (saved, read()) {
        (Ok(()), Some(kept)) => kept,
        _ => fallback.to_string(),
    }
}

/// 32 hex digits from the OS's randomness (the standard library's hash keys are seeded from it; no added dependency)
fn random_hex() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    (0..2u8)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u8(i);
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}
