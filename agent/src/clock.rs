//! Trust in this PC's clock, by generation (`clock-epoch.json`).
//!
//! Every value the agent takes in (a `/usage` result, a statusLine value, a Codex reading, a queued observation, `snapshot.json`)
//! carries the epoch read when it was started, and is used only while that epoch is current and trusted. A refusal of the clock by
//! the destination, its lifting, a discarded queue, or a send whose result is unknown each move to a new epoch: what came before is
//! never used again, whether or not it could be removed.
//!
//! The state is written only under `clock.lock`. Before an epoch is written, a mark naming it is created (a file per epoch), so a state
//! file that breaks is never replaced by an epoch issued before.

use std::fs::File;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::store::write_json_atomic;

pub const CLOCK_EPOCH_FILE: &str = "clock-epoch.json";
/// Held while the clock state changes, and by `collect --accept-account` while it accepts (a refusal saved meanwhile would leave an
/// acceptance made on a refused clock)
pub const CLOCK_LOCK_FILE: &str = "clock.lock";
/// One empty file per epoch issued (`clock-epoch-issued-<n>`): the highest names the last epoch ever issued
const ISSUED_PREFIX: &str = "clock-epoch-issued-";

/// The clock state
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClockEpoch {
    pub epoch: u64,
    /// Whether values of this epoch may be used and sent (false while the destination refuses the clock, or might have)
    pub trusted: bool,
    /// A send of this epoch whose result isn't recorded yet (set before the request). While set, nothing is accepted or used: the
    /// destination may have refused the clock
    #[serde(default)]
    pub in_flight: Option<u64>,
}

/// The clock state as read
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochRead {
    Missing,
    /// Exists but can't be read now, or its contents aren't a state
    Unreadable,
    Read {
        epoch: u64,
        trusted: bool,
        in_flight: Option<u64>,
    },
}

/// How reading the state file failed
enum ReadError {
    /// An I/O error: it may read fine a moment later (never replaced on this)
    Io,
    /// Read, but the contents aren't a state
    Broken,
}

fn read_state(home: &Path) -> Result<Option<ClockEpoch>, ReadError> {
    match std::fs::read(home.join(CLOCK_EPOCH_FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ReadError::Io),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| ReadError::Broken),
    }
}

pub fn clock_epoch(home: &Path) -> EpochRead {
    match read_state(home) {
        Ok(Some(e)) => EpochRead::Read {
            epoch: e.epoch,
            trusted: e.trusted,
            in_flight: e.in_flight,
        },
        Ok(None) => EpochRead::Missing,
        Err(_) => EpochRead::Unreadable,
    }
}

/// The epoch values may be taken in or used under now: the state is read, trusted, and no send's result is pending
pub fn usable_epoch(home: &Path) -> Option<u64> {
    match clock_epoch(home) {
        EpochRead::Read {
            epoch,
            trusted: true,
            in_flight: None,
        } => Some(epoch),
        _ => None,
    }
}

fn open_lock(home: &Path) -> Result<File, String> {
    std::fs::create_dir_all(home)
        .map_err(|e| format!("Couldn't create {}: {e}", home.display()))?;
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join(CLOCK_LOCK_FILE))
        .map_err(|e| format!("Couldn't open {CLOCK_LOCK_FILE}: {e}"))
}

/// Takes the clock lock (waits for the holder). Err if the lock file can't be opened or locked
pub fn hold_clock_lock(home: &Path) -> Result<File, String> {
    let file = open_lock(home)?;
    file.lock()
        .map_err(|e| format!("Couldn't lock {CLOCK_LOCK_FILE}: {e}"))?;
    Ok(file)
}

/// Takes the clock lock if free. Ok(None) while another holds it
pub fn try_clock_lock(home: &Path) -> Result<Option<File>, String> {
    let file = open_lock(home)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => {
            Err(format!("Couldn't lock {CLOCK_LOCK_FILE}: {e}"))
        }
    }
}

/// The highest epoch ever issued (0 if none). Err when the folder can't be listed
fn issued_max(home: &Path) -> Result<u64, String> {
    let entries =
        std::fs::read_dir(home).map_err(|e| format!("Couldn't list {}: {e}", home.display()))?;
    let mut max = 0;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Couldn't list {}: {e}", home.display()))?;
        if let Some(n) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.strip_prefix(ISSUED_PREFIX))
            .and_then(|n| n.parse::<u64>().ok())
        {
            max = max.max(n);
        }
    }
    Ok(max)
}

/// Writes the state (caller holds the clock lock): the mark of its epoch first, then the file. Marks two or more epochs behind are removed
/// (only tidying; the highest stays)
pub fn save_locked(home: &Path, state: &ClockEpoch) -> Result<(), String> {
    let mark = home.join(format!("{ISSUED_PREFIX}{}", state.epoch));
    if !mark.exists() {
        std::fs::write(&mark, b"")
            .map_err(|e| format!("Couldn't mark epoch {}: {e}", state.epoch))?;
    }
    write_json_atomic(&home.join(CLOCK_EPOCH_FILE), state)
        .map_err(|e| format!("Couldn't save {CLOCK_EPOCH_FILE}: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(home) {
        for entry in entries.flatten() {
            let old = entry
                .file_name()
                .to_str()
                .and_then(|n| n.strip_prefix(ISSUED_PREFIX))
                .and_then(|n| n.parse::<u64>().ok())
                .is_some_and(|n| n + 1 < state.epoch);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// The state, made under the clock lock (held by the caller) when there is none or it is broken:
/// - none and no epoch ever issued (first start): trusted, unless the push state of an earlier version says the destination refused the
///   clock (`refused_before`; Err when that can't be read, so nothing is made on a guess)
/// - none although an epoch was issued (the file was lost), or broken: a new epoch above every one issued, not trusted (a send that goes
///   through lifts it)
///
/// Err on an I/O error (it is tried again; nothing is replaced on it)
pub fn ensure_locked(
    home: &Path,
    refused_before: impl FnOnce() -> Result<bool, String>,
) -> Result<ClockEpoch, String> {
    match read_state(home) {
        Ok(Some(state)) => Ok(state),
        Err(ReadError::Io) => Err(format!("Couldn't read {CLOCK_EPOCH_FILE}")),
        Ok(None) => {
            let issued = issued_max(home)?;
            let state = if issued > 0 {
                ClockEpoch {
                    epoch: issued + 1,
                    trusted: false,
                    in_flight: None,
                }
            } else {
                ClockEpoch {
                    epoch: 1,
                    trusted: !refused_before()?,
                    in_flight: None,
                }
            };
            save_locked(home, &state)?;
            Ok(state)
        }
        Err(ReadError::Broken) => {
            let state = ClockEpoch {
                epoch: issued_max(home)? + 1,
                trusted: false,
                in_flight: None,
            };
            save_locked(home, &state)?;
            Ok(state)
        }
    }
}

/// A new epoch (caller holds the clock lock and read `state`): what came before is never used again
pub fn advance_locked(
    home: &Path,
    state: &ClockEpoch,
    trusted: bool,
) -> Result<ClockEpoch, String> {
    let next = ClockEpoch {
        epoch: state.epoch.max(issued_max(home)?) + 1,
        trusted,
        in_flight: None,
    };
    save_locked(home, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(label: &str) -> crate::test_util::TempHome {
        crate::test_util::TempHome::new(&format!("headroom-clock-{label}"))
    }

    #[test]
    fn a_first_start_is_trusted_unless_an_earlier_version_was_refused() {
        let h = home("first");
        assert_eq!(clock_epoch(&h), EpochRead::Missing);
        let made = ensure_locked(&h, || Ok(false)).unwrap();
        assert_eq!((made.epoch, made.trusted), (1, true));
        assert_eq!(usable_epoch(&h), Some(1));
        let refused = home("first-refused");
        let made = ensure_locked(&refused, || Ok(true)).unwrap();
        assert!(!made.trusted);
        assert_eq!(usable_epoch(&refused), None);
        // the earlier push state can't be read: nothing is made on a guess
        let unknown = home("first-unknown");
        assert!(ensure_locked(&unknown, || Err("can't read".into())).is_err());
        assert_eq!(clock_epoch(&unknown), EpochRead::Missing);
    }

    #[test]
    fn a_broken_or_lost_state_never_brings_back_an_epoch_issued_before() {
        let h = home("broken");
        let first = ensure_locked(&h, || Ok(false)).unwrap();
        let second = advance_locked(&h, &first, true).unwrap();
        assert_eq!(second.epoch, 2);
        std::fs::write(h.join(CLOCK_EPOCH_FILE), "{").unwrap();
        assert_eq!(clock_epoch(&h), EpochRead::Unreadable);
        let made = ensure_locked(&h, || Ok(false)).unwrap();
        assert_eq!(
            (made.epoch, made.trusted),
            (3, false),
            "above every epoch issued, and not trusted"
        );
        // lost altogether: the same
        std::fs::remove_file(h.join(CLOCK_EPOCH_FILE)).unwrap();
        let again = ensure_locked(&h, || Ok(false)).unwrap();
        assert_eq!((again.epoch, again.trusted), (4, false));
        // a state that can't be read for now (an I/O error) isn't replaced
        std::fs::remove_file(h.join(CLOCK_EPOCH_FILE)).unwrap();
        std::fs::create_dir(h.join(CLOCK_EPOCH_FILE)).unwrap();
        assert!(ensure_locked(&h, || Ok(false)).is_err());
        assert_eq!(clock_epoch(&h), EpochRead::Unreadable);
    }

    #[test]
    fn a_pending_send_or_a_refusal_makes_no_epoch_usable() {
        let h = home("usable");
        let state = ensure_locked(&h, || Ok(false)).unwrap();
        save_locked(
            &h,
            &ClockEpoch {
                in_flight: Some(state.epoch),
                ..state
            },
        )
        .unwrap();
        assert_eq!(usable_epoch(&h), None);
        save_locked(
            &h,
            &ClockEpoch {
                trusted: false,
                in_flight: None,
                ..state
            },
        )
        .unwrap();
        assert_eq!(usable_epoch(&h), None);
    }
}
