//! Time utilities. ISO8601 (UTC) formatting is done by hand to avoid extra dependencies.
//! All internal times are epoch milliseconds (i64); converted to ISO8601 only on output.

use std::time::{SystemTime, UNIX_EPOCH};

pub const MINUTE_MS: i64 = 60_000;

pub fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

pub fn system_time_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Epoch seconds / epoch milliseconds to ms. Values below 1e12 are treated as seconds (same rule as toIsoUtc in TS).
pub fn ms_from_epoch(v: f64) -> Option<i64> {
    if !v.is_finite() {
        return None;
    }
    Some(if v < 1e12 {
        (v * 1000.0).round() as i64
    } else {
        v.round() as i64
    })
}

/// Epoch milliseconds → `2026-11-16T12:00:00.000Z`
pub fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// (year, month, day) → days since 1970-01-01. Howard Hinnant's days_from_civil.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// This PC's current offset from UTC (minutes; +540 for Tokyo). None if unavailable.
/// `/usage` prints local time, so this converts it to UTC. May be off by an hour around a DST change.
pub fn local_utc_offset_min() -> Option<i32> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct SystemTime16([u16; 8]);
        #[repr(C)]
        struct TimeZoneInformation {
            bias: i32,
            standard_name: [u16; 32],
            standard_date: SystemTime16,
            standard_bias: i32,
            daylight_name: [u16; 32],
            daylight_date: SystemTime16,
            daylight_bias: i32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetTimeZoneInformation(info: *mut TimeZoneInformation) -> u32;
        }
        let mut info = std::mem::MaybeUninit::<TimeZoneInformation>::zeroed();
        // SAFETY: the struct has the same layout as Win32 TIME_ZONE_INFORMATION, and the function only writes to it
        let ret = unsafe { GetTimeZoneInformation(info.as_mut_ptr()) };
        if ret == u32::MAX {
            return None;
        }
        let info = unsafe { info.assume_init() };
        let extra = if ret == 2 {
            info.daylight_bias
        } else {
            info.standard_bias
        };
        Some(-(info.bias + extra))
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string(); // e.g. +0900
        let (sign, digits) = s.split_at_checked(1)?;
        let h: i32 = digits.get(0..2)?.parse().ok()?;
        let m: i32 = digits.get(2..4)?.parse().ok()?;
        let v = h * 60 + m;
        Some(if sign == "-" { -v } else { v })
    }
}

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's civil_from_days.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// How far ahead a provider ever sets the time it reads again a state it couldn't read (a minute), with room for the moments between
/// its clock reading and the caller's
const REREAD_AHEAD_MAX: i64 = 2 * MINUTE_MS;

/// When a provider reads again a state it couldn't read (`at`: set a minute after it found it so, on the wall clock then). None: no read
/// waits. A time further ahead than one is ever set was set before the wall clock went back: due now (read again at once, never held
/// off however often it is looked at). One that has come is due as it is (the read is made at once). Whether the state is unreadable
/// is another question: until a read succeeds (`at` is set)
pub fn reread_due(at: Option<i64>, now: i64) -> Option<i64> {
    at.map(|at| {
        if at > now.saturating_add(REREAD_AHEAD_MAX) {
            now
        } else {
            at
        }
    })
}

/// Whether a provider waits to read its state again (nothing is taken or asked for of it before)
pub fn rereads_later(at: Option<i64>, now: i64) -> bool {
    reread_due(at, now).is_some_and(|due| due > now)
}

/// The least sleep that counts: the OS's two clocks (sleep_clocks) drift apart by more than this only while asleep
const SUSPEND_MIN: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether the computer slept between two readings of the OS's two clocks (one that runs on while asleep, one that stops), for every
/// provider: a fetch cut off by a sleep is an ordinary failure, tried again. A reading that is missing tells nothing: not slept (the
/// fetch's result then stays as its provider decides without it)
pub fn slept_during(
    before: Option<(std::time::Duration, std::time::Duration)>,
    after: Option<(std::time::Duration, std::time::Duration)>,
) -> bool {
    match (before, after) {
        (Some((total0, awake0)), Some((total1, awake1))) => {
            total1
                .saturating_sub(total0)
                .saturating_sub(awake1.saturating_sub(awake0))
                > SUSPEND_MIN
        }
        _ => false,
    }
}

/// Which of the two clocks of sleep_clocks is read first. A pause between the two reads (the process held up) then makes the time
/// counted asleep shorter, never longer: at a span's start the one that stops while asleep goes first, at its end the one that runs on
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFirst {
    /// At a span's start
    Stopping,
    /// At a span's end
    RunningOn,
}

/// Time since an arbitrary point by two of the OS's clocks: (one that runs on while the computer sleeps, one that stops while it
/// sleeps), read in the order given. Their difference over a span is the time the computer slept in it; a clock set by hand or a busy
/// CPU moves neither apart (both count the same raw ticks while awake). None where they can't be read
pub fn sleep_clocks(first: ReadFirst) -> Option<(std::time::Duration, std::time::Duration)> {
    use std::time::Duration;
    #[cfg(windows)]
    let (running_on, stopping) = {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetTickCount64() -> u64;
            fn QueryUnbiasedInterruptTime(time: *mut u64) -> i32;
        }
        // The tick count runs on while asleep (milliseconds); the unbiased interrupt time stops (100 ns units)
        // SAFETY: GetTickCount64 takes nothing
        let running_on = || Some(Duration::from_millis(unsafe { GetTickCount64() }));
        let stopping = || {
            let mut t = 0u64;
            // SAFETY: QueryUnbiasedInterruptTime only writes the u64 it is given
            (unsafe { QueryUnbiasedInterruptTime(&mut t) } != 0)
                .then(|| Duration::from_nanos(t.saturating_mul(100)))
        };
        (running_on, stopping)
    };
    #[cfg(any(
        target_os = "macos",
        all(target_os = "linux", target_pointer_width = "64")
    ))]
    let (running_on, stopping) = {
        #[repr(C)]
        struct Timespec {
            sec: i64,
            nsec: i64,
        }
        unsafe extern "C" {
            fn clock_gettime(clock: i32, tp: *mut Timespec) -> i32;
        }
        // macOS: CLOCK_MONOTONIC_RAW (mach_continuous_time) runs on while asleep, CLOCK_UPTIME_RAW (mach_absolute_time) stops; neither
        // follows the wall clock. Linux: CLOCK_BOOTTIME and CLOCK_MONOTONIC
        let (runs_on, stops) = if cfg!(target_os = "macos") {
            (4, 8)
        } else {
            (7, 1)
        };
        let read = move |clock: i32| {
            let mut t = Timespec { sec: 0, nsec: 0 };
            // SAFETY: clock_gettime only writes the timespec it is given (64-bit fields on these 64-bit targets)
            let ok = unsafe { clock_gettime(clock, &mut t) } == 0;
            (ok && t.sec >= 0 && (0..1_000_000_000).contains(&t.nsec))
                .then(|| Duration::new(t.sec as u64, t.nsec as u32))
        };
        (move || read(runs_on), move || read(stops))
    };
    #[cfg(not(any(
        windows,
        target_os = "macos",
        all(target_os = "linux", target_pointer_width = "64")
    )))]
    let (running_on, stopping) = (|| None::<Duration>, || None::<Duration>);
    read_clocks(first, running_on, stopping)
}

/// Reads the two clocks in the order given: (running on, stopping)
pub fn read_clocks(
    first: ReadFirst,
    mut running_on: impl FnMut() -> Option<std::time::Duration>,
    mut stopping: impl FnMut() -> Option<std::time::Duration>,
) -> Option<(std::time::Duration, std::time::Duration)> {
    match first {
        ReadFirst::Stopping => {
            let s = stopping()?;
            Some((running_on()?, s))
        }
        ReadFirst::RunningOn => {
            let r = running_on()?;
            Some((r, stopping()?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_state_that_couldn_t_be_read_is_read_again_within_a_minute_also_on_a_clock_set_back() {
        let t = 1_800_000_000_000;
        assert_eq!(reread_due(None, t), None);
        assert!(!rereads_later(None, t));
        assert_eq!(reread_due(Some(t + MINUTE_MS), t), Some(t + MINUTE_MS));
        assert!(rereads_later(Some(t + MINUTE_MS), t));
        // a moment later than the caller's clock (read a little after it): still waited for
        assert!(rereads_later(Some(t + MINUTE_MS + 5), t));
        // its time has come: due as it is, read at once
        assert_eq!(reread_due(Some(t), t + 10), Some(t));
        assert!(!rereads_later(Some(t), t + 10));
        // set back an hour: due now, wherever it is looked at
        let back = t - 60 * MINUTE_MS;
        assert_eq!(reread_due(Some(t + MINUTE_MS), back), Some(back));
        assert_eq!(
            reread_due(Some(t + MINUTE_MS), back + 30_000),
            Some(back + 30_000)
        );
        assert!(!rereads_later(Some(t + MINUTE_MS), back));
    }

    #[test]
    fn a_pause_between_the_two_reads_never_counts_as_sleep() {
        use std::cell::Cell;
        use std::time::Duration;
        // awake all along (both clocks the same), the process held up 75 s after each first read
        let now = Cell::new(Duration::ZERO);
        let read = |first| {
            let n = Cell::new(0);
            let tick = || {
                let t = now.get();
                n.set(n.get() + 1);
                if n.get() == 1 {
                    now.set(t + Duration::from_secs(75));
                }
                Some(t)
            };
            read_clocks(first, tick, tick)
        };
        let before = read(ReadFirst::Stopping).unwrap();
        now.set(now.get() + Duration::from_secs(60));
        let after = read(ReadFirst::RunningOn).unwrap();
        let slept = (after.0 - before.0).saturating_sub(after.1 - before.1);
        assert_eq!(slept, Duration::ZERO, "{before:?} {after:?}");
        // the other order would count the pause as 150 s asleep
        now.set(Duration::ZERO);
        let before = read(ReadFirst::RunningOn).unwrap();
        now.set(now.get() + Duration::from_secs(60));
        let after = read(ReadFirst::Stopping).unwrap();
        assert!((after.0 - before.0).saturating_sub(after.1 - before.1) > Duration::from_secs(5));
    }

    #[cfg(any(
        windows,
        target_os = "macos",
        all(target_os = "linux", target_pointer_width = "64")
    ))]
    #[test]
    fn the_two_clocks_are_read_and_run_together_while_awake() {
        let (a0, b0) = sleep_clocks(ReadFirst::Stopping).expect("both clocks readable here");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (a1, b1) = sleep_clocks(ReadFirst::RunningOn).unwrap();
        let (ran_on, stopped) = (a1 - a0, b1 - b0);
        assert!(
            ran_on >= std::time::Duration::from_millis(150),
            "{ran_on:?}"
        );
        assert!(
            stopped >= std::time::Duration::from_millis(150),
            "{stopped:?}"
        );
        // awake: the gap between them stays well under a second (the tick count moves in steps of about 16 ms)
        let gap = ran_on.abs_diff(stopped);
        assert!(gap < std::time::Duration::from_millis(500), "{gap:?}");
    }

    #[test]
    fn civil_days_roundtrip() {
        for days in [-1, 0, 11_016, 20_408, 20_773] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(days_from_civil(2026, 11, 17), 20_774);
    }

    #[test]
    fn local_offset_is_plausible() {
        let off = local_utc_offset_min().expect("the UTC offset is available");
        assert!((-12 * 60..=14 * 60).contains(&off), "{off}");
    }

    #[test]
    fn iso_formatting_matches_js_to_iso_string() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_763_305_200_000), "2025-11-16T15:00:00.000Z");
        assert_eq!(iso_from_ms(951_782_400_123), "2000-02-29T00:00:00.123Z");
    }

    #[test]
    fn epoch_seconds_and_millis() {
        assert_eq!(ms_from_epoch(1_763_305_200.0), Some(1_763_305_200_000));
        assert_eq!(ms_from_epoch(1_763_305_200_000.0), Some(1_763_305_200_000));
        assert_eq!(ms_from_epoch(f64::NAN), None);
    }
}
