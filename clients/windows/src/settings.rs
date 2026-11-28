//! The settings window, in four tabs: Connection (the server, the read token, which goes to the credential store only, and the
//! sample switch; saved with Save), Placement, Appearance and Behavior (each change is shown and saved at once).

use crate::prefs::{FoldDelay, OpenOn, Prefs, Size, Theme, Tint};
use std::cell::{Cell, RefCell};
use windows::core::{w, Result, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::*;
use windows::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForWindow, SystemParametersInfoForDpi,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::*;

/** The trackbar's position, and centred or right-aligned static text (not in the bindings' features used here) */
const TBM_GETPOS: u32 = WM_USER;
const SS_CENTER: u32 = 1;
const SS_RIGHT: u32 = 2;

const ID_TABS: i32 = 9;
// Connection
const ID_URL: i32 = 10;
const ID_TOKEN: i32 = 11;
const ID_DEMO: i32 = 12;
const ID_REMOVE: i32 = 13;
const ID_TOKEN_HINT: i32 = 15;
const ID_URL_HINT: i32 = 17;
const ID_LEAD: i32 = 18;
const ID_URL_LABEL: i32 = 19;
const ID_TOKEN_LABEL: i32 = 20;
// Placement
const ID_SCREEN_LABEL: i32 = 30;
const ID_SCREEN: i32 = 31;
const ID_SCREEN_HINT: i32 = 32;
const ID_POS_LABEL: i32 = 33;
const ID_POS: i32 = 34;
const ID_POS_TOP: i32 = 35;
const ID_POS_MID: i32 = 36;
const ID_POS_BOTTOM: i32 = 37;
const ID_SIZE_LABEL: i32 = 38;
const ID_SIZE: i32 = 39;
// Appearance
const ID_THEME_LABEL: i32 = 50;
const ID_THEME: i32 = 51;
const ID_GLASS_GROUP: i32 = 52;
const ID_BACKDROP: i32 = 53;
const ID_BACKDROP_HINT: i32 = 54;
const ID_TINT_LABEL: i32 = 55;
const ID_TINT: i32 = 56;
const ID_MOTION: i32 = 57;
const ID_ICONS_GROUP: i32 = 58;
const ID_ICONS_HINT: i32 = 59;
/** The second-icon checkboxes: their providers and names, in the order they are shown */
const ID_ALT: [i32; 3] = [60, 61, 62];
const ALT_PROVIDERS: [&str; 3] = ["claude", "codex", "gemini"];
const ALT_NAMES: [&str; 3] = ["Claude", "Codex", "Gemini"];
// Behavior
const ID_OPEN_LABEL: i32 = 70;
const ID_OPEN: i32 = 71;
const ID_FOLD_LABEL: i32 = 72;
const ID_FOLD: i32 = 73;
const ID_FULL: i32 = 74;
const ID_STARTUP: i32 = 75;
// Always shown
const ID_STATUS: i32 = 14;
/** Save is the default button (Enter, on the Connection tab), Close the cancel one (Esc) */
const ID_SAVE: i32 = IDOK.0;
const ID_CLOSE: i32 = IDCANCEL.0;

const WIDTH: i32 = 540;
const HEIGHT: i32 = 500;
const STYLE: WINDOW_STYLE =
    WINDOW_STYLE(WS_OVERLAPPED.0 | WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0);

const TABS: [&str; 4] = ["Connection", "Placement", "Appearance", "Behavior"];
const SIZES: [(&str, Size); 3] = [
    ("Small", Size::Small),
    ("Normal", Size::Normal),
    ("Large", Size::Large),
];
const THEMES: [(&str, Theme); 4] = [
    ("System (as Windows' apps are)", Theme::System),
    ("Dark", Theme::Dark),
    ("Light", Theme::Light),
    ("Liquid Glass", Theme::Glass),
];
const TINTS: [(&str, Tint); 3] = [
    ("Clear", Tint::Clear),
    ("Dark", Tint::Dark),
    ("Light", Tint::Light),
];
const OPENS: [(&str, OpenOn); 2] = [
    ("When the pointer touches it", OpenOn::Hover),
    ("When it is clicked", OpenOn::Click),
];
const DELAYS: [(&str, FoldDelay); 3] = [
    ("Quickly", FoldDelay::Short),
    ("After a moment", FoldDelay::Normal),
    ("Slowly", FoldDelay::Long),
];

thread_local! {
    static HWND_NOW: Cell<isize> = const { Cell::new(0) };
    static FONTS: Cell<(isize, isize)> = const { Cell::new((0, 0)) };
    /** The tabs' page colour, for the labels and boxes that sit on it */
    static PANE: Cell<isize> = const { Cell::new(0) };
    static PAGE: Cell<usize> = const { Cell::new(0) };
    /** The screens' device names, in the order of the screen list ("" for automatic) */
    static SCREENS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /** Which of ALT_PROVIDERS has a second icon now (the others' choices are kept as they are, not shown) */
    static ALT_HAS: Cell<[bool; 3]> = const { Cell::new([false; 3]) };
    /** Filling the controls: their changes aren't taken as the user's */
    static LOADING: Cell<bool> = const { Cell::new(false) };
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

fn send(dlg: HWND, id: i32, msg: u32, wp: usize, lp: isize) -> isize {
    unsafe { SendMessageW(item(dlg, id), msg, Some(WPARAM(wp)), Some(LPARAM(lp))).0 }
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
    send(dlg, id, EM_SETCUEBANNER, 1, text.as_ptr() as isize);
}

fn checked(dlg: HWND, id: i32) -> bool {
    unsafe { IsDlgButtonChecked(dlg, id) == BST_CHECKED.0 }
}

fn check(dlg: HWND, id: i32, on: bool) {
    unsafe {
        let _ = CheckDlgButton(dlg, id, if on { BST_CHECKED } else { BST_UNCHECKED });
    }
}

/** Fills a drop-down list and selects an entry */
fn fill(dlg: HWND, id: i32, names: &[String], selected: usize) {
    send(dlg, id, CB_RESETCONTENT, 0, 0);
    for n in names {
        let t = wide(n);
        send(dlg, id, CB_ADDSTRING, 0, t.as_ptr() as isize);
    }
    send(dlg, id, CB_SETCURSEL, selected, 0);
}

/** A drop-down list of named values, with the current one selected */
fn fill_named<T: PartialEq + Copy>(dlg: HWND, id: i32, names: &[(&str, T)], now: T) {
    let list: Vec<String> = names.iter().map(|(n, _)| n.to_string()).collect();
    fill(
        dlg,
        id,
        &list,
        names.iter().position(|(_, t)| *t == now).unwrap_or(0),
    );
}

fn selected<T: Copy>(dlg: HWND, id: i32, names: &[(&str, T)], default: T) -> T {
    let i = send(dlg, id, CB_GETCURSEL, 0, 0);
    usize::try_from(i)
        .ok()
        .and_then(|i| names.get(i))
        .map_or(default, |(_, t)| *t)
}

/** Fills the connection fields from the settings (the token itself is never shown, only whether one is kept) */
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
    check(dlg, ID_DEMO, demo);
    set_text(
        dlg,
        ID_TOKEN_HINT,
        &format!(
            "A read token for this PC (not a PC's write token). Kept in Windows Credential Manager. Time zone: {}.",
            crate::server::local_time_zone()
        ),
    );
}

/** The screens, from left to right, for the screen list (automatic first) */
fn load_screens(dlg: HWND, display: &str) {
    let monitors = crate::screens::list();
    let many = monitors.len() > 1;
    let mut names = vec!["Automatic (the screen furthest right)".to_string()];
    let mut keys = vec![String::new()];
    for (n, m) in monitors.iter().enumerate() {
        let w = m.bounds.right - m.bounds.left;
        let h = m.bounds.bottom - m.bounds.top;
        let side = match (many, n) {
            (false, _) => "",
            (true, 0) => ", left",
            (true, n) if n + 1 == monitors.len() => ", right",
            _ => ", middle",
        };
        let main = if m.primary { ", main" } else { "" };
        names.push(format!("{} ({w}×{h}{side}{main})", m.name));
        keys.push(m.device.clone());
    }
    let mut at = keys.iter().position(|k| k == display).unwrap_or(0);
    if !display.is_empty() && at == 0 {
        // Chosen before, not connected now: kept, and the notch is on the automatic one meanwhile
        names.push("A screen not connected now (automatic meanwhile)".to_string());
        keys.push(display.to_string());
        at = keys.len() - 1;
    }
    fill(dlg, ID_SCREEN, &names, at);
    SCREENS.with(|s| *s.borrow_mut() = keys);
}

/** Fills the placement, appearance and behavior tabs from the prefs */
fn load_prefs(dlg: HWND) {
    LOADING.with(|l| l.set(true));
    let p = crate::prefs();
    load_screens(dlg, &p.display);
    send(dlg, ID_POS, TBM_SETRANGE, 1, (100 << 16) as isize);
    send(dlg, ID_POS, TBM_SETTICFREQ, 25, 0);
    send(dlg, ID_POS, TBM_SETPAGESIZE, 0, 10);
    send(dlg, ID_POS, TBM_SETPOS, 1, p.position as isize);
    fill_named(dlg, ID_SIZE, &SIZES, p.size);
    fill_named(dlg, ID_THEME, &THEMES, p.theme);
    check(dlg, ID_BACKDROP, p.glass_backdrop);
    fill_named(dlg, ID_TINT, &TINTS, p.glass_tint);
    check(dlg, ID_MOTION, p.motion);
    fill_named(dlg, ID_OPEN, &OPENS, p.open_on);
    fill_named(dlg, ID_FOLD, &DELAYS, p.fold_delay);
    check(dlg, ID_FULL, p.hide_fullscreen);
    load_icons(dlg, &p);
    check(dlg, ID_STARTUP, crate::startup::enabled());
    enable_glass(dlg, p.theme == Theme::Glass);
    LOADING.with(|l| l.set(false));
}

/** The second-icon checkboxes: one per provider that has a second icon (read again from the icon folder each time) */
fn load_icons(dlg: HWND, p: &Prefs) {
    let has = ALT_PROVIDERS.map(crate::art::has_alt);
    ALT_HAS.with(|h| h.set(has));
    let any = has.contains(&true);
    for (n, provider) in ALT_PROVIDERS.into_iter().enumerate() {
        check(dlg, ID_ALT[n], has[n] && p.alt_icons.contains(&provider));
        unsafe {
            let _ = EnableWindow(item(dlg, ID_ALT[n]), has[n]);
            // None to choose: the boxes aren't shown, only where to put the icons
            let shown = any && PAGE.with(Cell::get) == 2;
            let _ = ShowWindow(item(dlg, ID_ALT[n]), if shown { SW_SHOW } else { SW_HIDE });
        }
    }
    let folder =
        crate::art::folder().map_or_else(String::new, |d| d.join("alt").display().to_string());
    set_text(
        dlg,
        ID_ICONS_HINT,
        &if any {
            "Use the second icon for:".to_string()
        } else {
            format!("Put a second set of icons in {folder} to choose between them.")
        },
    );
}

/** The glass's choices only matter with the Liquid Glass theme */
fn enable_glass(dlg: HWND, on: bool) {
    for id in [ID_BACKDROP, ID_BACKDROP_HINT, ID_TINT_LABEL, ID_TINT] {
        unsafe {
            let _ = EnableWindow(item(dlg, id), on);
        }
    }
}

/** The prefs as the controls show them */
fn prefs_shown(dlg: HWND) -> Prefs {
    let d = crate::prefs();
    let screen = send(dlg, ID_SCREEN, CB_GETCURSEL, 0, 0);
    let display = SCREENS.with(|s| {
        usize::try_from(screen)
            .ok()
            .and_then(|i| s.borrow().get(i).cloned())
            .unwrap_or_else(|| d.display.clone())
    });
    Prefs {
        display,
        position: send(dlg, ID_POS, TBM_GETPOS, 0, 0).clamp(0, 100) as u8,
        size: selected(dlg, ID_SIZE, &SIZES, d.size),
        theme: selected(dlg, ID_THEME, &THEMES, d.theme),
        glass_backdrop: checked(dlg, ID_BACKDROP),
        glass_tint: selected(dlg, ID_TINT, &TINTS, d.glass_tint),
        open_on: selected(dlg, ID_OPEN, &OPENS, d.open_on),
        fold_delay: selected(dlg, ID_FOLD, &DELAYS, d.fold_delay),
        motion: checked(dlg, ID_MOTION),
        hide_fullscreen: checked(dlg, ID_FULL),
        // A provider whose second icon isn't there now keeps its choice (the icon may come back)
        alt_icons: {
            let has = ALT_HAS.with(Cell::get);
            crate::model::PROVIDER_ORDER
                .into_iter()
                .filter(|p| match ALT_PROVIDERS.iter().position(|a| a == p) {
                    Some(n) if has[n] => checked(dlg, ID_ALT[n]),
                    _ => d.alt_icons.contains(p),
                })
                .collect()
        },
    }
}

/** A change on the placement, appearance or behavior tab: shown at once, and saved unless `write` is false (the slider while it
 * is being dragged) */
fn take_prefs(dlg: HWND, write: bool) {
    if LOADING.with(Cell::get) {
        return;
    }
    let p = prefs_shown(dlg);
    enable_glass(dlg, p.theme == Theme::Glass);
    match crate::set_prefs(p, write) {
        Ok(()) => set_text(dlg, ID_STATUS, if write { "Saved." } else { "" }),
        Err(e) => set_text(
            dlg,
            ID_STATUS,
            &format!("{e}: shown until Headroom ends, but not saved."),
        ),
    }
}

fn command(dlg: HWND, id: i32, code: u32) {
    match id {
        ID_SAVE if PAGE.with(Cell::get) == 0 => {
            let url = get_text(dlg, ID_URL);
            // Out of the field at once: it never stays in the window, whether the save works or not
            let token = get_text(dlg, ID_TOKEN);
            set_text(dlg, ID_TOKEN, "");
            let typed = !token.trim().is_empty();
            let demo = checked(dlg, ID_DEMO);
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
        ID_REMOVE if code == BN_CLICKED => match crate::remove_token() {
            Ok(()) => {
                load(dlg);
                set_text(dlg, ID_STATUS, "Token removed.");
            }
            Err(e) => set_text(dlg, ID_STATUS, &e),
        },
        ID_CLOSE => unsafe {
            let _ = DestroyWindow(dlg);
        },
        ID_SCREEN | ID_SIZE | ID_THEME | ID_TINT | ID_OPEN | ID_FOLD if code == CBN_SELCHANGE => {
            take_prefs(dlg, true)
        }
        ID_BACKDROP | ID_MOTION | ID_FULL if code == BN_CLICKED => take_prefs(dlg, true),
        _ if ID_ALT.contains(&id) && code == BN_CLICKED => take_prefs(dlg, true),
        ID_STARTUP if code == BN_CLICKED => {
            let on = checked(dlg, ID_STARTUP);
            match crate::startup::set(on) {
                Ok(()) => set_text(dlg, ID_STATUS, "Saved."),
                Err(e) => {
                    check(dlg, ID_STARTUP, !on);
                    set_text(dlg, ID_STATUS, &format!("{e}."));
                }
            }
        }
        _ => {}
    }
}

/** Shows one tab's controls (and hides the others') */
fn show_page(dlg: HWND, page: usize) {
    PAGE.with(|p| p.set(page));
    let any_alt = ALT_HAS.with(Cell::get).contains(&true);
    for c in controls() {
        if let Some(on) = c.page {
            // The second-icon boxes only when there is a second icon to choose
            let shown = on == page && (any_alt || !ID_ALT.contains(&c.id));
            unsafe {
                let _ = ShowWindow(item(dlg, c.id), if shown { SW_SHOW } else { SW_HIDE });
            }
        }
    }
    set_text(
        dlg,
        ID_STATUS,
        if page == 0 {
            ""
        } else {
            "Changes here are shown and saved at once."
        },
    );
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_COMMAND => {
                let id = (wp.0 & 0xffff) as i32;
                let code = ((wp.0 >> 16) & 0xffff) as u32;
                command(hwnd, id, code);
                LRESULT(0)
            }
            WM_NOTIFY => {
                let hdr = &*(lp.0 as *const NMHDR);
                if hdr.idFrom == ID_TABS as usize && hdr.code == TCN_SELCHANGE {
                    let page = send(hwnd, ID_TABS, TCM_GETCURSEL, 0, 0);
                    show_page(hwnd, usize::try_from(page).unwrap_or(0));
                }
                LRESULT(0)
            }
            // The window in the tabs' page colour, so what is drawn over it (group boxes, labels) matches the page
            WM_ERASEBKGND => {
                let pane = PANE.with(Cell::get);
                if pane == 0 {
                    return DefWindowProcW(hwnd, msg, wp, lp);
                }
                let mut r = RECT::default();
                let _ = GetClientRect(hwnd, &mut r);
                FillRect(HDC(wp.0 as *mut _), &r, HBRUSH(pane as *mut _));
                LRESULT(1)
            }
            // The position slider: shown as it moves, saved when it is let go
            WM_HSCROLL => {
                if HWND(lp.0 as *mut _) == item(hwnd, ID_POS) {
                    let code = (wp.0 & 0xffff) as u32;
                    take_prefs(hwnd, code == TB_ENDTRACK);
                }
                LRESULT(0)
            }
            // Screens connected or taken away: the list again
            WM_DISPLAYCHANGE => {
                LOADING.with(|l| l.set(true));
                load_screens(hwnd, &crate::prefs().display);
                LOADING.with(|l| l.set(false));
                LRESULT(0)
            }
            // The labels on the window's own background
            WM_CTLCOLORSTATIC => {
                let dc = HDC(wp.0 as *mut _);
                SetBkMode(dc, TRANSPARENT);
                let control = HWND(lp.0 as *mut _);
                let hint = [
                    ID_URL_HINT,
                    ID_TOKEN_HINT,
                    ID_SCREEN_HINT,
                    ID_BACKDROP_HINT,
                    ID_ICONS_HINT,
                    ID_POS_TOP,
                    ID_POS_MID,
                    ID_POS_BOTTOM,
                ]
                .contains(&GetDlgCtrlID(control));
                SetTextColor(dc, COLORREF(if hint { 0x0070_6e6e } else { 0x0000_0000 }));
                // The tabs' page colour, which the whole window has (group boxes draw the window's background inside them)
                let pane = PANE.with(Cell::get);
                if pane != 0 {
                    LRESULT(pane)
                } else {
                    LRESULT(GetSysColorBrush(COLOR_WINDOW).0 as isize)
                }
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
                let pane = PANE.with(|p| p.replace(0));
                if pane != 0 {
                    let _ = DeleteObject(HGDIOBJ(pane as *mut _));
                }
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

/** The message font at this window's DPI, and a bold one for the labels that head a choice */
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
        let mut head = m.lfMessageFont;
        head.lfWeight = FW_SEMIBOLD.0 as i32;
        (body, CreateFontIndirectW(&head))
    }
}

/** A brush of the colour the tabs' page is drawn in (the visual style's, else the classic face colour) */
fn pane_brush(tabs: HWND) -> HBRUSH {
    unsafe {
        let mut color = GetSysColor(COLOR_BTNFACE);
        let theme = OpenThemeData(Some(tabs), w!("TAB"));
        if !theme.is_invalid() {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, 40, 40);
            let old = SelectObject(mem, bitmap.into());
            let r = RECT {
                left: 0,
                top: 0,
                right: 40,
                bottom: 40,
            };
            if DrawThemeBackground(theme, mem, TABP_PANE.0, 0, &r, None).is_ok() {
                let c = GetPixel(mem, 20, 20);
                if c.0 != CLR_INVALID {
                    color = c.0;
                }
            }
            SelectObject(mem, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            let _ = CloseThemeData(theme);
        }
        CreateSolidBrush(COLORREF(color))
    }
}

/** Opens the settings (or brings them to the front) */
pub fn open() {
    if let Some(h) = hwnd() {
        // The icon folder read again, as when it opens
        LOADING.with(|l| l.set(true));
        load_icons(h, &crate::prefs());
        LOADING.with(|l| l.set(false));
        crate::notch::post_place();
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

/** One control of the window: its class, text, style, id, place (at 96 DPI), tab (None: always shown) and whether it heads a
 * choice (bold) */
struct Control {
    class: PCWSTR,
    text: &'static str,
    style: u32,
    id: i32,
    rect: (i32, i32, i32, i32),
    page: Option<usize>,
    head: bool,
}

/** The tab's content: from here, this wide */
const X: i32 = 32;
const CW: i32 = WIDTH - 64;
const LEAD: &str = "Shows the usage limits your Headroom server has. It reads the server every 5 minutes at most, and never touches Claude, Codex or Gemini itself.";
const BACKDROP_HINT: &str = "While the notch is open it reads the part of the screen right behind it, in memory only: nothing is saved or sent. While this is on, screenshots and recordings leave the notch out. Off, it only looks like glass.";

fn controls() -> Vec<Control> {
    let tab = WS_TABSTOP.0;
    let list = CBS_DROPDOWNLIST as u32 | WS_VSCROLL.0 | tab;
    let check = BS_AUTOCHECKBOX as u32 | tab;
    let c = |class, text, style, id, rect, page: usize| Control {
        class,
        text,
        style,
        id,
        rect,
        page: Some(page),
        head: false,
    };
    let head = |text, id, rect, page| Control {
        head: true,
        ..c(w!("STATIC"), text, 0, id, rect, page)
    };
    let label = |text, id, rect, page| c(w!("STATIC"), text, 0, id, rect, page);
    vec![
        Control {
            page: None,
            ..c(w!("SysTabControl32"), "", WS_CLIPSIBLINGS.0 | tab, ID_TABS, (12, 12, WIDTH - 24, 410), 0)
        },
        // Connection
        label(LEAD, ID_LEAD, (X, 52, CW, 36), 0),
        head("Server", ID_URL_LABEL, (X, 98, CW, 18), 0),
        c(w!("EDIT"), "", ES_AUTOHSCROLL as u32 | tab, ID_URL, (X, 118, CW, 24), 0),
        label(
            "The https:// address of your Worker, with the host name only.",
            ID_URL_HINT,
            (X, 146, CW, 18),
            0,
        ),
        head("Read token", ID_TOKEN_LABEL, (X, 176, CW, 18), 0),
        c(
            w!("EDIT"),
            "",
            (ES_AUTOHSCROLL | ES_PASSWORD) as u32 | tab,
            ID_TOKEN,
            (X, 196, CW, 24),
            0,
        ),
        label("", ID_TOKEN_HINT, (X, 224, CW, 34), 0),
        c(
            w!("BUTTON"),
            "Show sample data instead of the server",
            check,
            ID_DEMO,
            (X, 266, CW, 22),
            0,
        ),
        c(w!("BUTTON"), "Save", BS_DEFPUSHBUTTON as u32 | tab, ID_SAVE, (X, 306, 96, 28), 0),
        c(
            w!("BUTTON"),
            "Remove token",
            BS_PUSHBUTTON as u32 | tab,
            ID_REMOVE,
            (X + 104, 306, 120, 28),
            0,
        ),
        // Placement
        head("Screen", ID_SCREEN_LABEL, (X, 56, CW, 18), 1),
        c(w!("COMBOBOX"), "", list, ID_SCREEN, (X, 76, CW, 240), 1),
        label(
            "On the automatic one the pointer stops at the notch's edge, as no screen is right of it.",
            ID_SCREEN_HINT,
            (X, 106, CW, 34),
            1,
        ),
        head("Position on the edge", ID_POS_LABEL, (X, 150, CW, 18), 1),
        c(
            w!("msctls_trackbar32"),
            "",
            (TBS_HORZ | TBS_AUTOTICKS) | tab,
            ID_POS,
            (X - 6, 170, CW + 12, 32),
            1,
        ),
        label("Top", ID_POS_TOP, (X, 204, 80, 18), 1),
        Control {
            style: SS_CENTER,
            ..label("Middle", ID_POS_MID, (X + CW / 2 - 40, 204, 80, 18), 1)
        },
        Control {
            style: SS_RIGHT,
            ..label("Bottom", ID_POS_BOTTOM, (X + CW - 80, 204, 80, 18), 1)
        },
        head("Size", ID_SIZE_LABEL, (X, 240, CW, 18), 1),
        c(w!("COMBOBOX"), "", list, ID_SIZE, (X, 260, 200, 200), 1),
        // Appearance
        head("Theme", ID_THEME_LABEL, (X, 56, CW, 18), 2),
        c(w!("COMBOBOX"), "", list, ID_THEME, (X, 76, 280, 200), 2),
        c(
            w!("BUTTON"),
            "Liquid Glass",
            BS_GROUPBOX as u32,
            ID_GLASS_GROUP,
            (X, 118, CW, 150),
            2,
        ),
        c(
            w!("BUTTON"),
            "Blur and bend what is behind it",
            check,
            ID_BACKDROP,
            (X + 16, 142, CW - 32, 22),
            2,
        ),
        label(BACKDROP_HINT, ID_BACKDROP_HINT, (X + 34, 166, CW - 50, 52), 2),
        label("Tint", ID_TINT_LABEL, (X + 16, 228, 60, 18), 2),
        c(w!("COMBOBOX"), "", list, ID_TINT, (X + 80, 224, 160, 200), 2),
        c(
            w!("BUTTON"),
            "Animations (opening, folding and moving the card)",
            check,
            ID_MOTION,
            (X, 284, CW, 22),
            2,
        ),
        c(
            w!("BUTTON"),
            "Icons",
            BS_GROUPBOX as u32,
            ID_ICONS_GROUP,
            (X, 312, CW, 98),
            2,
        ),
        label("", ID_ICONS_HINT, (X + 16, 334, CW - 32, 34), 2),
        c(w!("BUTTON"), ALT_NAMES[0], check, ID_ALT[0], (X + 16, 372, 120, 22), 2),
        c(w!("BUTTON"), ALT_NAMES[1], check, ID_ALT[1], (X + 146, 372, 120, 22), 2),
        c(w!("BUTTON"), ALT_NAMES[2], check, ID_ALT[2], (X + 276, 372, 120, 22), 2),
        // Behavior
        head("Open the notch", ID_OPEN_LABEL, (X, 56, CW, 18), 3),
        c(w!("COMBOBOX"), "", list, ID_OPEN, (X, 76, 300, 200), 3),
        head("Fold it after the pointer leaves", ID_FOLD_LABEL, (X, 118, CW, 18), 3),
        c(w!("COMBOBOX"), "", list, ID_FOLD, (X, 138, 300, 200), 3),
        c(
            w!("BUTTON"),
            "Hide it while a full-screen app (a game, a video) is in front",
            check,
            ID_FULL,
            (X, 184, CW, 22),
            3,
        ),
        c(
            w!("BUTTON"),
            "Start Headroom when you sign in to Windows",
            check,
            ID_STARTUP,
            (X, 214, CW, 22),
            3,
        ),
        // Always shown
        Control {
            page: None,
            ..label("", ID_STATUS, (20, 434, WIDTH - 150, 40), 0)
        },
        Control {
            page: None,
            ..c(
                w!("BUTTON"),
                "Close",
                BS_PUSHBUTTON as u32 | tab,
                ID_CLOSE,
                (WIDTH - 116, 438, 96, 28),
                0,
            )
        },
    ]
}

/** Places and sizes the controls and sets their fonts for a DPI (at the start, and when the window moves to a screen of another
 * scale) */
fn lay_out(dlg: HWND, dpi: u32) {
    let s = |v: i32| v * dpi as i32 / 96;
    let (body, head) = fonts(dpi);
    let (old_body, old_head) = FONTS.with(|f| f.replace((body.0 as isize, head.0 as isize)));
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
            let font = if c.head { head } else { body };
            SendMessageW(
                h,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            );
        }
        for f in [old_body, old_head] {
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
            let visible = if c.page.is_none_or(|p| p == 0) {
                WS_VISIBLE
            } else {
                WINDOW_STYLE(0)
            };
            let _ = CreateWindowExW(
                ex,
                c.class,
                PCWSTR(t.as_ptr()),
                WINDOW_STYLE(c.style) | WS_CHILD | visible,
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
        // The tabs, under the controls that sit on them
        let tabs = item(dlg, ID_TABS);
        for (n, name) in TABS.iter().enumerate() {
            let mut text = wide(name);
            let t = TCITEMW {
                mask: TCIF_TEXT,
                pszText: windows::core::PWSTR(text.as_mut_ptr()),
                ..Default::default()
            };
            SendMessageW(
                tabs,
                TCM_INSERTITEMW,
                Some(WPARAM(n)),
                Some(LPARAM(&t as *const _ as isize)),
            );
        }
        let _ = SetWindowPos(
            tabs,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        PANE.with(|p| p.set(pane_brush(tabs).0 as isize));
        lay_out(dlg, dpi);
        cue(dlg, ID_URL, "https://headroom.example.workers.dev");
        HWND_NOW.with(|h| h.set(dlg.0 as isize));
        PAGE.with(|p| p.set(0));
        load(dlg);
        load_prefs(dlg);
        // The notch reads the icon folder again too (icons put there since are taken up)
        crate::notch::post_place();
        let _ = ShowWindow(dlg, SW_SHOW);
        let _ = SetForegroundWindow(dlg);
        let _ = SetFocus(Some(item(dlg, ID_URL)));
    }
    Ok(())
}
