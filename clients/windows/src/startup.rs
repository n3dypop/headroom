//! Starting with Windows: a value in the signed-in user's Run key naming this program (nothing else is changed). It starts it with
//! --keep-running, so a crash is followed by a new start (keep.rs).

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::*;

const RUN: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const NAME: PCWSTR = w!("Headroom");

/** The command the Run key gets: this program, quoted, kept running */
fn command() -> Option<String> {
    Some(format!("{} {}", earlier_command()?, crate::keep::FLAG))
}

/** What earlier versions put in the Run key: this program, quoted */
fn earlier_command() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!("\"{}\"", exe.display()))
}

/** The Run value, when there is one */
fn value() -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let got = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            RUN,
            NAME,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if got != ERROR_SUCCESS {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/** Whether Windows starts this program at sign-in (the Run value names this program, as now or as earlier versions did) */
pub fn enabled() -> bool {
    let Some(now) = value() else { return false };
    [command(), earlier_command()]
        .into_iter()
        .flatten()
        .any(|c| now.eq_ignore_ascii_case(&c))
}

/** A Run value an earlier version wrote for this program gets the restart after a crash (from the next sign-in) */
pub fn update() {
    if let (Some(now), Some(earlier)) = (value(), earlier_command()) {
        if now.eq_ignore_ascii_case(&earlier) {
            let _ = set(true);
        }
    }
}

/** Starts this program at sign-in, or stops doing so */
pub fn set(on: bool) -> Result<(), String> {
    let cmd = command().ok_or("Couldn't find this program")?;
    unsafe {
        let mut key = HKEY::default();
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            RUN,
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        ) != ERROR_SUCCESS
        {
            return Err("Couldn't change what starts with Windows".into());
        }
        let done = if on {
            let wide: Vec<u16> = cmd.encode_utf16().chain([0]).collect();
            let bytes = std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2);
            RegSetValueExW(key, NAME, None, REG_SZ, Some(bytes))
        } else {
            let r = RegDeleteValueW(key, NAME);
            if r == windows::Win32::Foundation::ERROR_FILE_NOT_FOUND {
                ERROR_SUCCESS
            } else {
                r
            }
        };
        let _ = RegCloseKey(key);
        if done == ERROR_SUCCESS {
            Ok(())
        } else {
            Err("Couldn't change what starts with Windows".into())
        }
    }
}
