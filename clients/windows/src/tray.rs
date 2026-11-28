//! The tray icon: its tooltip says what is left; its menu lists each provider, then Refresh now, Settings… and Quit.

use crate::model::Tray;
use std::cell::RefCell;
use windows::core::{w, Result};
use windows::Win32::Foundation::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const ID_REFRESH: u32 = 100;
const ID_SETTINGS: u32 = 101;
const ID_QUIT: u32 = 102;
/** The provider lines' ids (shown dimmed: they only read out) */
const ID_LINES: u32 = 200;

struct State {
    hwnd: HWND,
    icon: HICON,
    shown: Tray,
    /** Sent when Explorer starts again: the icon must be added again */
    taskbar_created: u32,
}

thread_local! {
    static TRAY: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn wide_into(dst: &mut [u16], s: &str) {
    let mut n = 0;
    for (d, c) in dst.iter_mut().zip(s.encode_utf16()) {
        *d = c;
        n += 1;
    }
    if n < dst.len() {
        dst[n] = 0;
    } else if let Some(last) = dst.last_mut() {
        *last = 0;
    }
}

fn data(s: &State) -> NOTIFYICONDATAW {
    let mut d = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: s.hwnd,
        uID: 1,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: crate::WM_APP_TRAY,
        hIcon: s.icon,
        ..Default::default()
    };
    wide_into(&mut d.szTip, &s.shown.tooltip);
    d
}

fn add(s: &State) {
    unsafe {
        let _ = Shell_NotifyIconW(NIM_ADD, &data(s));
    }
}

/** Shows new lines and a new tooltip (only when they changed) */
pub fn set(next: Tray) {
    let update = TRAY.with(|t| {
        let mut t = t.try_borrow_mut().ok()?;
        let s = t.as_mut()?;
        if s.shown == next {
            return None;
        }
        s.shown = next;
        Some(data(s))
    });
    if let Some(d) = update {
        unsafe {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &d);
        }
    }
}

pub fn remove() {
    let Some(s) = TRAY.with(|t| t.try_borrow_mut().ok().and_then(|mut t| t.take())) else {
        return;
    };
    unsafe {
        let _ = Shell_NotifyIconW(NIM_DELETE, &data(&s));
        let _ = DestroyIcon(s.icon);
    }
}

/** The icon's data as shown now (None while the state is in use or gone) */
fn current() -> Option<NOTIFYICONDATAW> {
    TRAY.with(|t| t.try_borrow().ok().and_then(|t| t.as_ref().map(data)))
}

fn show_menu(hwnd: HWND) {
    // Copied out: the menu runs its own message loop, during which the lines may change
    let lines = TRAY.with(|t| {
        t.try_borrow()
            .ok()
            .and_then(|t| t.as_ref().map(|s| s.shown.lines.clone()))
            .unwrap_or_default()
    });
    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        for (n, line) in lines.iter().enumerate() {
            let text: Vec<u16> = line.encode_utf16().chain([0]).collect();
            let _ = AppendMenuW(
                menu,
                MF_STRING | MF_GRAYED,
                (ID_LINES + n as u32) as usize,
                windows::core::PCWSTR(text.as_ptr()),
            );
        }
        if !lines.is_empty() {
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
        }
        let _ = AppendMenuW(menu, MF_STRING, ID_REFRESH as usize, w!("Refresh now"));
        let _ = AppendMenuW(menu, MF_STRING, ID_SETTINGS as usize, w!("Settings…"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, None);
        let _ = AppendMenuW(menu, MF_STRING, ID_QUIT as usize, w!("Quit Headroom"));
        let mut at = POINT::default();
        let _ = GetCursorPos(&mut at);
        // The menu closes when clicking elsewhere only if its window is in front
        let _ = SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
            at.x,
            at.y,
            Some(0),
            hwnd,
            None,
        );
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        match cmd.0 as u32 {
            ID_REFRESH => crate::refresh_from_menu(),
            ID_SETTINGS => crate::settings::open(),
            ID_QUIT => crate::quit(),
            _ => {}
        }
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == crate::WM_APP_TRAY {
        let event = (lp.0 & 0xffff) as u32;
        if event == WM_LBUTTONUP || event == WM_RBUTTONUP {
            show_menu(hwnd);
        }
        return LRESULT(0);
    }
    let created = TRAY.with(|t| {
        t.try_borrow()
            .ok()
            .and_then(|t| t.as_ref().map(|s| s.taskbar_created))
    });
    if created == Some(msg) && msg != 0 {
        if let Some(d) = current() {
            unsafe {
                let _ = Shell_NotifyIconW(NIM_ADD, &d);
            }
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

/** The tray icon, from the app's own icon (a PNG, which Windows takes as an icon image) */
fn load_icon() -> Result<HICON> {
    let png = include_bytes!("../icons/tray.png");
    unsafe {
        let size = GetSystemMetrics(SM_CXSMICON);
        CreateIconFromResourceEx(png, true, 0x0003_0000, size, size, LR_DEFAULTCOLOR)
    }
}

pub fn create() -> Result<()> {
    unsafe {
        let hinst = GetModuleHandleW(None)?;
        let class = w!("HeadroomTray");
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: class,
            ..Default::default()
        });
        // A window of its own, never shown, that the menu can bring to the front (the notch never takes the focus)
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Headroom"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinst.into()),
            None,
        )?;
        let state = State {
            hwnd,
            icon: load_icon()?,
            shown: Tray {
                lines: Vec::new(),
                tooltip: "Headroom".to_string(),
            },
            taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
        };
        add(&state);
        TRAY.with(|t| *t.borrow_mut() = Some(state));
    }
    Ok(())
}
