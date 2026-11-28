//! The monitors: which one the notch goes on, their names for the settings, and whether a full-screen app covers one.

use windows::core::BOOL;
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Debug)]
pub struct Monitor {
    pub handle: HMONITOR,
    /// As \\.\DISPLAY2 (what the settings keep)
    pub device: String,
    /// The monitor's own name when Windows has it (else "Display N")
    pub name: String,
    pub bounds: RECT,
    pub primary: bool,
}

fn wstr(buf: &[u16]) -> String {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
}

/** The monitors' own names by device name (\\.\DISPLAY2 → "DELL U2720Q"), from the display configuration */
fn friendly_names() -> Vec<(String, String)> {
    let mut out = Vec::new();
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != ERROR_SUCCESS {
            return out;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return out;
        }
        for p in paths.iter().take(np as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: p.sourceInfo.adapterId,
                    id: p.sourceInfo.id,
                },
                ..Default::default()
            };
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                    adapterId: p.targetInfo.adapterId,
                    id: p.targetInfo.id,
                },
                ..Default::default()
            };
            if DisplayConfigGetDeviceInfo(&mut source.header) == 0
                && DisplayConfigGetDeviceInfo(&mut target.header) == 0
            {
                let name = wstr(&target.monitorFriendlyDeviceName);
                if !name.is_empty() {
                    out.push((wstr(&source.viewGdiDeviceName), name));
                }
            }
        }
    }
    out
}

/** The monitors, from left to right (then top to bottom) */
pub fn list() -> Vec<Monitor> {
    unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(m);
        TRUE
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    let mut out = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut handles as *mut _ as isize),
        );
    }
    let names = friendly_names();
    for m in handles {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(m, &mut info.monitorInfo) }.as_bool() {
            continue;
        }
        let device = wstr(&info.szDevice);
        let number = device
            .trim_start_matches("\\\\.\\DISPLAY")
            .parse::<u32>()
            .ok();
        let name = names
            .iter()
            .find(|(d, _)| *d == device)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| number.map_or("Display".to_string(), |n| format!("Display {n}")));
        out.push(Monitor {
            handle: m,
            device,
            name,
            bounds: info.monitorInfo.rcMonitor,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    out.sort_by_key(|m| (m.bounds.left, m.bounds.top));
    out
}

/** Of the monitors' bounds (and whether each is the primary), the one reaching furthest right, so no monitor is right of it and
 * the pointer stops at its edge; the primary among those that reach as far (monitors stacked one above the other), else the
 * first */
pub fn rightmost(monitors: &[(RECT, bool)]) -> Option<usize> {
    let right = monitors.iter().map(|(r, _)| r.right).max()?;
    let at_edge = || {
        monitors
            .iter()
            .enumerate()
            .filter(move |(_, (r, _))| r.right == right)
    };
    at_edge()
        .find(|(_, (_, primary))| *primary)
        .or_else(|| at_edge().next())
        .map(|(i, _)| i)
}

/** The monitor the notch goes on: the one the settings name when it is connected, else the one furthest right */
pub fn pick(monitors: &[Monitor], display: &str) -> Option<usize> {
    if !display.is_empty() {
        if let Some(i) = monitors.iter().position(|m| m.device == display) {
            return Some(i);
        }
    }
    let bounds: Vec<(RECT, bool)> = monitors.iter().map(|m| (m.bounds, m.primary)).collect();
    rightmost(&bounds)
}

/** The monitor for the settings' choice (the primary when none can be listed) */
pub fn monitor_for(display: &str) -> HMONITOR {
    let all = list();
    match pick(&all, display) {
        Some(i) => all[i].handle,
        None => unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) },
    }
}

/** Whether the window in front covers the whole monitor as a full-screen app does (a game, a video; also one spread over several
 * monitors), not a maximized window nor the desktop itself */
pub fn fullscreen_on(monitor: HMONITOR, own: HWND) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() || fg == own || IsZoomed(fg).as_bool() || !IsWindowVisible(fg).as_bool()
        {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, &mut class);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        if [
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
        ]
        .contains(&class.as_str())
        {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let mut r = RECT::default();
        if !GetMonitorInfoW(monitor, &mut info).as_bool() || GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let m = info.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn the_notch_goes_on_the_monitor_nothing_is_right_of() {
        assert_eq!(rightmost(&[]), None);
        assert_eq!(rightmost(&[(r(0, 0, 1920, 1080), true)]), Some(0));
        // The primary in the middle, one on each side: the right one, not the primary
        let three = [
            (r(0, 0, 1920, 1080), true),
            (r(1920, 0, 3840, 1080), false),
            (r(-1920, 105, 0, 1185), false),
        ];
        assert_eq!(rightmost(&three), Some(1));
        // One left of the primary: the primary
        assert_eq!(
            rightmost(&[(r(-2560, 0, 0, 1440), false), (r(0, 0, 1920, 1080), true)]),
            Some(1)
        );
        // Stacked, reaching as far right: the primary, else the first
        assert_eq!(
            rightmost(&[(r(0, -1080, 1920, 0), false), (r(0, 0, 1920, 1080), true)]),
            Some(1)
        );
        assert_eq!(
            rightmost(&[
                (r(0, -1080, 1920, 0), false),
                (r(0, 1080, 1920, 2160), false)
            ]),
            Some(0)
        );
    }

    #[test]
    fn a_chosen_monitor_is_used_only_while_it_is_connected() {
        let m = |device: &str, bounds, primary| Monitor {
            handle: HMONITOR::default(),
            device: device.into(),
            name: String::new(),
            bounds,
            primary,
        };
        let all = [
            m("\\\\.\\DISPLAY3", r(-1920, 0, 0, 1080), false),
            m("\\\\.\\DISPLAY1", r(0, 0, 1920, 1080), true),
            m("\\\\.\\DISPLAY2", r(1920, 0, 3840, 1080), false),
        ];
        assert_eq!(pick(&all, ""), Some(2));
        assert_eq!(pick(&all, "\\\\.\\DISPLAY3"), Some(0));
        assert_eq!(
            pick(&all, "\\\\.\\DISPLAY9"),
            Some(2),
            "gone: the one furthest right"
        );
    }
}
