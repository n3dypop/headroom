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

#[cfg(test)]
mod tests {
    use super::*;

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
