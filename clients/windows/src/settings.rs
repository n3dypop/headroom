//! The settings window: the server, the read token (to the credential store only) and the sample switch.

use std::cell::Cell;
use windows::core::{w, Result, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::*;
use windows::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForWindow, SystemParametersInfoForDpi,
};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

const ID_URL: i32 = 10;
const ID_TOKEN: i32 = 11;
const ID_DEMO: i32 = 12;
const ID_REMOVE: i32 = 13;
const ID_STATUS: i32 = 14;
const ID_TOKEN_HINT: i32 = 15;
const ID_TITLE: i32 = 16;
const ID_URL_HINT: i32 = 17;
const ID_LEAD: i32 = 18;
const ID_URL_LABEL: i32 = 19;
const ID_TOKEN_LABEL: i32 = 20;
/** Save is the default button (Enter), Close the cancel one (Esc) */
const ID_SAVE: i32 = IDOK.0;
const ID_CLOSE: i32 = IDCANCEL.0;

const WIDTH: i32 = 460;
const HEIGHT: i32 = 420;
const STYLE: WINDOW_STYLE =
    WINDOW_STYLE(WS_OVERLAPPED.0 | WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0);

thread_local! {
    static HWND_NOW: Cell<isize> = const { Cell::new(0) };
    static FONTS: Cell<(isize, isize)> = const { Cell::new((0, 0)) };
}

/** The settings window while it is open (the message loop hands it the keyboard: Tab, Enter, Esc) */
pub fn hwnd() -> Option<HWND> {
    let h = HWND_NOW.with(Cell::get);
    (h != 0).then_some(HWND(h as *mut _))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn item(dlg: HWND, id: i32) -> HWND {
    unsafe { GetDlgItem(Some(dlg), id).unwrap_or_default() }
}

fn set_text(dlg: HWND, id: i32, s: &str) {
    let text = wide(s);
    unsafe {
        let _ = SetWindowTextW(item(dlg, id), PCWSTR(text.as_ptr()));
    }
}

fn get_text(dlg: HWND, id: i32) -> String {
    let h = item(dlg, id);
    unsafe {
        let n = GetWindowTextLengthW(h);
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(h, &mut buf);
        String::from_utf16_lossy(&buf[..got as usize])
    }
}

fn cue(dlg: HWND, id: i32, s: &str) {
    let text = wide(s);
    unsafe {
        SendMessageW(
            item(dlg, id),
            EM_SETCUEBANNER,
            Some(WPARAM(1)),
            Some(LPARAM(text.as_ptr() as isize)),
        );
    }
}

/** Fills the fields from the settings (the token itself is never shown, only whether one is kept) */
fn load(dlg: HWND) {
    let (url, has_token, demo) = crate::settings_now();
    set_text(dlg, ID_URL, &url);
    set_text(dlg, ID_TOKEN, "");
    cue(
        dlg,
        ID_TOKEN,
        if has_token {
            "Saved (leave empty to keep it)"
        } else {
            ""
        },
    );
    unsafe {
        CheckDlgButton(dlg, ID_DEMO, if demo { BST_CHECKED } else { BST_UNCHECKED }).ok();
    }
    set_text(
        dlg,
        ID_TOKEN_HINT,
        &format!(
            "A read token for this PC (not a PC's write token). Kept in Windows Credential Manager. Time zone: {}.",
            crate::server::local_time_zone()
        ),
    );
}

fn command(dlg: HWND, id: i32) {
    match id {
        ID_SAVE => {
            let url = get_text(dlg, ID_URL);
            // Out of the field at once: it never stays in the window, whether the save works or not
            let token = get_text(dlg, ID_TOKEN);
            set_text(dlg, ID_TOKEN, "");
            let typed = !token.trim().is_empty();
            let demo = unsafe { IsDlgButtonChecked(dlg, ID_DEMO) } == BST_CHECKED.0;
            match crate::save_settings(&url, Some(token).filter(|t| !t.trim().is_empty()), demo) {
                Ok(()) => {
                    load(dlg);
                    set_text(dlg, ID_STATUS, "Saved.");
                }
                Err(e) => {
                    let again = if !typed {
                        String::new()
                    } else {
                        " Enter the token again.".to_string()
                    };
                    set_text(dlg, ID_STATUS, &format!("{e}.{again}").replace("..", "."));
                }
            }
        }
        ID_REMOVE => match crate::remove_token() {
            Ok(()) => {
                load(dlg);
                set_text(dlg, ID_STATUS, "Token removed.");
            }
            Err(e) => set_text(dlg, ID_STATUS, &e),
        },
        ID_CLOSE => unsafe {
            let _ = DestroyWindow(dlg);
        },
        _ => {}
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_COMMAND => {
                let id = (wp.0 & 0xffff) as i32;
                let code = ((wp.0 >> 16) & 0xffff) as u32;
                if code == BN_CLICKED || id == ID_SAVE || id == ID_CLOSE {
                    command(hwnd, id);
                }
                LRESULT(0)
            }
            // The labels on the window's own background
            WM_CTLCOLORSTATIC => {
                let dc = HDC(wp.0 as *mut _);
                SetBkMode(dc, TRANSPARENT);
                let control = HWND(lp.0 as *mut _);
                let hint = [ID_URL_HINT, ID_TOKEN_HINT].contains(&GetDlgCtrlID(control));
                SetTextColor(dc, COLORREF(if hint { 0x0070_6e6e } else { 0x0000_0000 }));
                LRESULT(GetSysColorBrush(COLOR_WINDOW).0 as isize)
            }
            // Moved to a screen of another scale: the suggested size, then the controls and fonts at the new DPI
            WM_DPICHANGED => {
                let r = &*(lp.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                lay_out(hwnd, ((wp.0 >> 16) & 0xffff) as u32);
                LRESULT(0)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                HWND_NOW.with(|h| h.set(0));
                let (a, b) = FONTS.with(Cell::take);
                for f in [a, b] {
                    if f != 0 {
                        let _ = DeleteObject(HGDIOBJ(f as *mut _));
                    }
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

/** The message font at this window's DPI, and a larger bold one for the title */
fn fonts(dpi: u32) -> (HFONT, HFONT) {
    unsafe {
        let mut m = NONCLIENTMETRICSW {
            cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
            ..Default::default()
        };
        let _ = SystemParametersInfoForDpi(
            SPI_GETNONCLIENTMETRICS.0,
            m.cbSize,
            Some(&mut m as *mut _ as *mut _),
            0,
            dpi,
        );
        let body = CreateFontIndirectW(&m.lfMessageFont);
        let mut title = m.lfMessageFont;
        title.lfHeight = title.lfHeight * 3 / 2;
        title.lfWeight = FW_BOLD.0 as i32;
        (body, CreateFontIndirectW(&title))
    }
}

/** Opens the settings (or brings them to the front) */
pub fn open() {
    if let Some(h) = hwnd() {
        unsafe {
            let _ = ShowWindow(h, SW_RESTORE);
            let _ = SetForegroundWindow(h);
        }
        return;
    }
    if let Err(e) = build() {
        eprintln!("settings: {e}");
    }
}

/** One control of the window: its class, text, style, id and place (at 96 DPI) */
struct Control {
    class: PCWSTR,
    text: &'static str,
    style: u32,
    id: i32,
    rect: (i32, i32, i32, i32),
    title: bool,
}

const X: i32 = 20;
const CW: i32 = WIDTH - 40;
const LEAD: &str = "Shows the usage limits your Headroom server has. It reads the server every 5 minutes at most, and never touches Claude, Codex or Gemini itself.";

fn controls() -> [Control; 13] {
    let tab = WS_TABSTOP.0;
    let c = |class, text, style, id, rect| Control {
        class,
        text,
        style,
        id,
        rect,
        title: false,
    };
    [
        Control {
            title: true,
            ..c(w!("STATIC"), "Headroom", 0, ID_TITLE, (X, 16, CW, 26))
        },
        c(w!("STATIC"), LEAD, 0, ID_LEAD, (X, 48, CW, 40)),
        c(w!("STATIC"), "Server", 0, ID_URL_LABEL, (X, 100, CW, 18)),
        c(
            w!("EDIT"),
            "",
            ES_AUTOHSCROLL as u32 | tab,
            ID_URL,
            (X, 120, CW, 24),
        ),
        c(
            w!("STATIC"),
            "The https:// address of your Worker, with the host name only.",
            0,
            ID_URL_HINT,
            (X, 148, CW, 18),
        ),
        c(
            w!("STATIC"),
            "Read token",
            0,
            ID_TOKEN_LABEL,
            (X, 178, CW, 18),
        ),
        c(
            w!("EDIT"),
            "",
            (ES_AUTOHSCROLL | ES_PASSWORD) as u32 | tab,
            ID_TOKEN,
            (X, 198, CW, 24),
        ),
        c(w!("STATIC"), "", 0, ID_TOKEN_HINT, (X, 226, CW, 34)),
        c(
            w!("BUTTON"),
            "Show sample data instead of the server",
            BS_AUTOCHECKBOX as u32 | tab,
            ID_DEMO,
            (X, 268, CW, 22),
        ),
        c(
            w!("BUTTON"),
            "Save",
            BS_DEFPUSHBUTTON as u32 | tab,
            ID_SAVE,
            (X, 306, 96, 28),
        ),
        c(
            w!("BUTTON"),
            "Close",
            BS_PUSHBUTTON as u32 | tab,
            ID_CLOSE,
            (X + 104, 306, 96, 28),
        ),
        c(
            w!("BUTTON"),
            "Remove token",
            BS_PUSHBUTTON as u32 | tab,
            ID_REMOVE,
            (X + 208, 306, 120, 28),
        ),
        c(w!("STATIC"), "", 0, ID_STATUS, (X, 346, CW, 40)),
    ]
}

/** Places and sizes the controls and sets their fonts for a DPI (at the start, and when the window moves to a screen of another
 * scale) */
fn lay_out(dlg: HWND, dpi: u32) {
    let s = |v: i32| v * dpi as i32 / 96;
    let (body, title) = fonts(dpi);
    let (old_body, old_title) = FONTS.with(|f| f.replace((body.0 as isize, title.0 as isize)));
    unsafe {
        for c in controls() {
            let h = item(dlg, c.id);
            let (x, y, cw, ch) = c.rect;
            let _ = SetWindowPos(
                h,
                None,
                s(x),
                s(y),
                s(cw),
                s(ch),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let font = if c.title { title } else { body };
            SendMessageW(
                h,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            );
        }
        for f in [old_body, old_title] {
            if f != 0 {
                let _ = DeleteObject(HGDIOBJ(f as *mut _));
            }
        }
    }
}

fn build() -> Result<()> {
    unsafe {
        let hinst = GetModuleHandleW(None)?;
        let class = w!("HeadroomSettings");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let dlg = CreateWindowExW(
            WS_EX_CONTROLPARENT,
            class,
            w!("Headroom Settings"),
            STYLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            WIDTH,
            HEIGHT,
            None,
            None,
            Some(hinst.into()),
            None,
        )?;
        // The client area at the window's DPI, centered on the primary work area; once more if the move took it to a screen of
        // another scale (the controls are laid out after, at the DPI it ends at)
        let mut area = RECT::default();
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut area as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let place = |dpi: u32| {
            let mut r = RECT {
                left: 0,
                top: 0,
                right: WIDTH * dpi as i32 / 96,
                bottom: HEIGHT * dpi as i32 / 96,
            };
            let _ = AdjustWindowRectExForDpi(&mut r, STYLE, false, WS_EX_CONTROLPARENT, dpi);
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            let _ = SetWindowPos(
                dlg,
                None,
                area.left + (area.right - area.left - w) / 2,
                area.top + (area.bottom - area.top - h) / 2,
                w,
                h,
                SWP_NOZORDER,
            );
        };
        let mut dpi = GetDpiForWindow(dlg).max(96);
        place(dpi);
        let now = GetDpiForWindow(dlg).max(96);
        if now != dpi {
            dpi = now;
            place(dpi);
        }
        for c in controls() {
            let t = wide(c.text);
            let ex = if c.class == w!("EDIT") {
                WS_EX_CLIENTEDGE
            } else {
                WINDOW_EX_STYLE(0)
            };
            let _ = CreateWindowExW(
                ex,
                c.class,
                PCWSTR(t.as_ptr()),
                WINDOW_STYLE(c.style) | WS_CHILD | WS_VISIBLE,
                0,
                0,
                0,
                0,
                Some(dlg),
                Some(HMENU(c.id as isize as *mut _)),
                Some(hinst.into()),
                None,
            );
        }
        lay_out(dlg, dpi);
        cue(dlg, ID_URL, "https://headroom.example.workers.dev");
        HWND_NOW.with(|h| h.set(dlg.0 as isize));
        load(dlg);
        let _ = ShowWindow(dlg, SW_SHOW);
        let _ = SetForegroundWindow(dlg);
        let _ = SetFocus(Some(item(dlg, ID_URL)));
    }
    Ok(())
}
