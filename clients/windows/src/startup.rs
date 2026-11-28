//! Starting with Windows: a value in the signed-in user's Run key naming this program (nothing else is changed).

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::*;

const RUN: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const NAME: PCWSTR = w!("Headroom");

/** The command the Run key gets: this program, quoted */
fn command() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!("\"{}\"", exe.display()))
}

/** Whether Windows starts this program at sign-in (the Run value names this program) */
pub fn enabled() -> bool {
    let Some(want) = command() else { return false };
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
        return false;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n]).eq_ignore_ascii_case(&want)
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
