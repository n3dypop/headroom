//! The notch: a pill against the right edge of the screen with one ring per provider, folded to a small nub until the pointer
//! touches it, and a card beside the ring under the pointer. It is a layered window drawn with per-pixel alpha, so the pointer
//! goes through it wherever nothing is drawn; around what is drawn it paints an all but invisible margin to keep the pointer.

use crate::gfx::{pt, rect, Gfx, Place};
use crate::glass::{self, Glass};
use crate::model::{self, CardRow, Cell, Pieces, View};
use crate::prefs::{OpenOn, Prefs, Theme};
use crate::theme::{self, Palette};
use std::cell::RefCell;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use windows::core::{w, Interface, Result};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::*;

// The layout, in device-independent pixels
const WIN_W: f32 = 380.0;
const WIN_H: f32 = 660.0;
const PILL_W: f32 = 64.0;
const FLARE: f32 = 22.0;
const PILL_PAD: f32 = FLARE + 14.0;
const CELL_GAP: f32 = 12.0;
const RING_PX: f32 = 44.0;
const PCT_GAP: f32 = 4.0;
const PCT_LINE: f32 = 16.0;
const CELL_H: f32 = RING_PX + PCT_GAP + PCT_LINE;
const CARD_W: f32 = 252.0;
const CARD_RIGHT: f32 = PILL_W + 14.0;
/** The ring's own units (its drawing is 48 across, shown at 44) */
const VB: f32 = 48.0;
const RING_R: f32 = 19.0;
const RING_STROKE: f32 = 5.0;
const OUTER_R: f32 = 23.4;
const OUTER_STROKE: f32 = 1.6;
/** The icon's box inside the ring (the ring's inner edge is at 16.5) */
const ICON_BOX: f32 = 19.0;
/** The folded nub at the edge */
const NUB_W: f32 = 7.0;
const NUB_H: f32 = 64.0;
/** The margin around what is drawn that keeps the pointer (the folded nub's is wider, to catch it) */
const HOT_PAD: f32 = 6.0;
const NUB_HOT_W: f32 = 14.0;

/** The widget's gray for the recent consumption */
const RECENT: &str = "#6B7280";
/** Two letters in the ring when no icon was supplied, so Claude and Codex differ */
const MARKS: [(&str, &str); 3] = [("claude", "Cl"), ("codex", "Cx"), ("gemini", "Ge")];

const FOLD_MS: f32 = 340.0;
const CARD_MOVE_MS: f32 = 260.0;
/** How often what is behind the glass is read again while the notch is open */
const GLASS_MS: u32 = 250;
/** How often the window in front is checked for a full-screen app */
const FULL_MS: u32 = 1_000;
/** The glass's bevel: the band along its edge that bends what is behind */
const BEVEL: f32 = 7.0;
/** How long "Next read in N min" stays after a click */
const NOTE_MS: u128 = 4_000;

/** Place the notch again (posted, so it runs after the change that asked for it) */
const WM_APP_PLACE: u32 = WM_APP + 3;
/** The rest of the pending work */
const WM_APP_DRAIN: u32 = WM_APP + 4;

const T_ANIM: usize = 1;
const T_FOLD: usize = 2;
const T_CARD: usize = 3;
const T_TICK: usize = 4;
const T_FULL: usize = 5;
const T_GLASS: usize = 6;

/** The notch window, for the reader thread to post to */
pub static HWND_VALUE: AtomicIsize = AtomicIsize::new(0);

thread_local! {
    static NOTCH: RefCell<Option<Notch>> = const { RefCell::new(None) };
    /** Work that came in while the notch was busy (a Win32 call made during an update sent a message back): done once it is free */
    static PENDING: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    /** A message is on its way to do the rest of the pending work */
    static DRAIN_POSTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /** A placement is on its way (a burst of screen changes asks once) */
    static PLACE_POSTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

const P_STATE: u8 = 1;
const P_PLACE: u8 = 2;
const P_LEAVE: u8 = 4;

/** cubic-bezier(.32, .72, .24, 1): quick at first, then settling (the fold and the card) */
fn ease(t: f32) -> f32 {
    let (x1, y1, x2, y2) = (0.32f32, 0.72f32, 0.24f32, 1.0f32);
    let t = t.clamp(0.0, 1.0);
    let bez = |a: f32, b: f32, s: f32| {
        3.0 * a * s * (1.0 - s).powi(2) + 3.0 * b * s * s * (1.0 - s) + s.powi(3)
    };
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if bez(x1, x2, mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez(y1, y2, (lo + hi) / 2.0)
}

/** A value moving from one place to another over a time */
struct Anim {
    from: f32,
    to: f32,
    start: Instant,
    ms: f32,
}

impl Anim {
    fn still(v: f32, ms: f32) -> Anim {
        Anim {
            from: v,
            to: v,
            start: Instant::now(),
            ms,
        }
    }
    fn progress(&self) -> f32 {
        (self.start.elapsed().as_secs_f32() * 1000.0 / self.ms).clamp(0.0, 1.0)
    }
    fn value(&self) -> f32 {
        self.from + (self.to - self.from) * ease(self.progress())
    }
    fn moving(&self) -> bool {
        self.from != self.to && self.progress() < 1.0
    }
    fn go(&mut self, to: f32) {
        if to != self.to {
            self.from = self.value();
            self.to = to;
            self.start = Instant::now();
        }
    }
    fn jump(&mut self, v: f32) {
        self.from = v;
        self.to = v;
    }
}

struct Icon {
    bitmap: ID2D1Bitmap,
    w: f32,
    h: f32,
}

/** The bitmap the window shows: a 32-bit top-down DIB that Direct2D draws into */
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    /** The pixels (for the development build's frame dump) */
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    bits: *const u8,
    w: i32,
    h: i32,
}

impl Surface {
    fn new(w: i32, h: i32) -> Result<Surface> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err(windows::core::Error::from_thread());
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(b) => b,
                Err(e) => {
                    let _ = DeleteDC(dc);
                    return Err(e);
                }
            };
            let old = SelectObject(dc, bitmap.into());
            if old.is_invalid() {
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
                return Err(windows::core::Error::from_thread());
            }
            Ok(Surface {
                dc,
                bitmap,
                old,
                bits: bits as *const u8,
                w,
                h,
            })
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

struct Formats {
    pct: IDWriteTextFormat,
    letter: IDWriteTextFormat,
    name: IDWriteTextFormat,
    label: IDWriteTextFormat,
    body: IDWriteTextFormat,
    small: IDWriteTextFormat,
}

fn formats(g: &Gfx) -> Result<Formats> {
    const UI: &str = "Segoe UI Variable Text";
    Ok(Formats {
        pct: g.format(UI, 12.0, DWRITE_FONT_WEIGHT_SEMI_BOLD)?,
        letter: g.format("Segoe UI", 12.5, DWRITE_FONT_WEIGHT_BOLD)?,
        name: g.format(UI, 14.0, DWRITE_FONT_WEIGHT_BOLD)?,
        label: g.format(UI, 12.0, DWRITE_FONT_WEIGHT_SEMI_BOLD)?,
        body: g.format(UI, 12.0, DWRITE_FONT_WEIGHT_NORMAL)?,
        small: g.format(UI, 11.0, DWRITE_FONT_WEIGHT_NORMAL)?,
    })
}

/** The size an icon of that shape is drawn at in place of a square of side `box_`: the widget's iconBox */
fn icon_box(aspect: f32, box_: f32) -> (f32, f32) {
    let ar = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        1.0
    };
    if ar < 1.0 {
        return (box_ * ar, box_);
    }
    let w = (box_ * ar.sqrt()).min(box_ * 1.5);
    (w, w / ar)
}

/** A PNG's width / height from its header (1 when it can't be read): the widget's pngAspect */
fn png_aspect(png: &[u8]) -> f32 {
    if png.len() < 24 || !png.starts_with(b"\x89PNG") {
        return 1.0;
    }
    let u32_at = |o: usize| u32::from_be_bytes([png[o], png[o + 1], png[o + 2], png[o + 3]]) as f32;
    let (w, h) = (u32_at(16), u32_at(20));
    if w > 0.0 && h > 0.0 {
        w / h
    } else {
        1.0
    }
}

pub struct Notch {
    hwnd: HWND,
    gfx: Gfx,
    fmt: Formats,
    surface: Option<Surface>,
    dpi: f32,
    scale: f32,
    /** The scale of the frame on the screen (the pointer's positions are read at it) */
    shown_scale: f32,
    win_h: f32,
    pos: POINT,
    icons: Vec<(&'static str, Icon)>,
    view: Option<Arc<View>>,
    cells: Vec<Cell>,
    footer: (String, bool),
    note: Option<(String, Instant)>,
    /** 0 folded, 1 open */
    fold: Anim,
    /** The cell whose card shows */
    card: Option<usize>,
    card_top: Anim,
    tracking: bool,
    /** When the card goes and the pill folds after the pointer left (a timer already queued checks these, so a pointer
     * that came back keeps them) */
    card_at: Option<Instant>,
    fold_at: Option<Instant>,
    /** How far the card's rows are scrolled (DIPs) when the window can't hold them all */
    card_scroll: f32,
    /** Where the card and its up and down lines were last drawn (for the wheel and clicks) */
    card_box: std::cell::Cell<Option<[f32; 4]>>,
    up_box: std::cell::Cell<Option<[f32; 4]>>,
    down_box: std::cell::Cell<Option<[f32; 4]>>,
    /** The bitmap's size in pixels (made again from it when it couldn't be made) */
    size: (i32, i32),
    /** The render target is to be made again (with the bitmap and the icons) */
    target_lost: bool,
    icons_stale: bool,
    /** Drawing failures in a row (the target is made again; after a few, it waits for the next change) */
    failures: u32,
    /** Kept open with the first card (HEADROOM_DESKTOP_OPEN=1, for checking the look) */
    pinned: bool,
    tick_ms: u32,
    /** How it looks and behaves (taken again at each placement) */
    prefs: Prefs,
    /** Windows' apps are light (for the System theme) */
    system_light: bool,
    glass: Glass,
    /** The monitor it is on */
    monitor: HMONITOR,
    /** Hidden while a full-screen app is in front */
    hidden: bool,
    /** Left out of screen copies (so the glass, reading what is behind, never reads itself) */
    excluded: bool,
}

/** How a card is laid out: whether its rows scroll, how far they are scrolled and can be, their room, and the card's height */
struct CardFit {
    scrolls: bool,
    offset: f32,
    max: f32,
    area: f32,
    h: f32,
}

/** How a cell's card is laid out in the window's height. When its rows don't all fit, the lines for moving up and down and
 * the footer get their room first, and the rows scroll by pixels in what is left (so every row can be reached whole) */
fn card_fit(cell: Option<&Cell>, win_h: f32, scroll: f32) -> CardFit {
    let mut fixed = 1.0 + 12.0 + 18.9 + 11.0 + 1.0 + 8.0 + 14.85 + 13.0 + 1.0;
    let Some(c) = cell else {
        return CardFit {
            scrolls: false,
            offset: 0.0,
            max: 0.0,
            area: 0.0,
            h: fixed,
        };
    };
    if c.message.is_some() {
        fixed += 8.0 + 16.2;
    }
    let room = win_h - 16.0;
    let all: f32 = c.rows.iter().map(row_height).sum();
    if fixed + all <= room {
        return CardFit {
            scrolls: false,
            offset: 0.0,
            max: 0.0,
            area: all,
            h: fixed + all,
        };
    }
    // A window too short for the rows to scroll in (a work area under 300 DIP high): a notice in their place
    if win_h < MIN_SCROLL_WIN_H {
        return CardFit {
            scrolls: false,
            offset: 0.0,
            max: 0.0,
            area: MORE_LINE,
            h: fixed + MORE_LINE,
        };
    }
    // At least a row's height for the rows, however short the window (the card may then reach past it)
    let area = (room - fixed - 2.0 * MORE_LINE).max(ROW_H);
    let max = (all - area).max(0.0);
    let offset = scroll.clamp(0.0, max);
    CardFit {
        scrolls: true,
        offset,
        max,
        area,
        h: fixed + 2.0 * MORE_LINE + area,
    }
}

/** A row of a card: a limit (heading, bar, what is left) or a limit the provider hasn't (heading only) */
fn row_height(r: &CardRow) -> f32 {
    10.0 + 16.2
        + if matches!(r, CardRow::Limit { .. }) {
            5.0 + 5.0 + 4.0 + 14.85
        } else {
            0.0
        }
}

/** A limit's row; a scroll step */
const ROW_H: f32 = 10.0 + 16.2 + 5.0 + 5.0 + 4.0 + 14.85;
/** The line for moving the rows up or down */
const MORE_LINE: f32 = 10.0 + 16.2;
/** The shortest window in which a card's rows scroll (below it the card says the rows are in the tray menu) */
const MIN_SCROLL_WIN_H: f32 = 300.0;

struct Layout {
    n: usize,
    pill_x: f32,
    pill_y: f32,
    pill_h: f32,
}

impl Layout {
    fn cell_top(&self, i: usize) -> f32 {
        self.pill_y + PILL_PAD + i as f32 * (CELL_H + CELL_GAP)
    }
    fn ring_centre(&self, i: usize) -> f32 {
        self.cell_top(i) + RING_PX / 2.0
    }
    /** The cell under a point of the pill (the rows meet halfway across the gaps) */
    fn cell_at(&self, x: f32, y: f32) -> Option<usize> {
        if x < self.pill_x {
            return None;
        }
        (0..self.n).find(|&i| {
            let top = self.cell_top(i);
            y >= top - CELL_GAP / 2.0 && y < top + CELL_H + CELL_GAP / 2.0
        })
    }
}

fn mark_of(provider: &str) -> &'static str {
    MARKS
        .iter()
        .find(|(p, _)| *p == provider)
        .map_or("?", |(_, m)| m)
}

impl Notch {
    fn layout(&self) -> Layout {
        let n = self.cells.len().max(1);
        let pill_h = 2.0 * PILL_PAD + n as f32 * CELL_H + (n as f32 - 1.0) * CELL_GAP;
        Layout {
            n,
            pill_x: WIN_W - PILL_W,
            pill_y: crate::prefs::along(self.prefs.position, self.win_h, self.win_h, pill_h).1,
            pill_h,
        }
    }

    /** The icons in use: each provider's second when chosen and there, else its first */
    fn load_icons(&mut self) {
        self.icons.clear();
        for p in model::PROVIDER_ORDER {
            let alt = self.prefs.alt_icons.contains(&p);
            // The second when chosen, else (or when it can't be drawn) the first
            let tries = if alt {
                [true, false].as_slice()
            } else {
                [false].as_slice()
            };
            let drawn = tries.iter().find_map(|&second| {
                let png = crate::art::png(p, second)?;
                let bitmap = self.gfx.png(&png).ok()?;
                let (w, h) = icon_box(png_aspect(&png), ICON_BOX);
                Some(Icon { bitmap, w, h })
            });
            if let Some(icon) = drawn {
                self.icons.push((p, icon));
            }
        }
    }

    /** Against the right edge of the desktop: the work area (above the taskbar) of the monitor nothing is right of, centered
     * vertically */
    fn place(&mut self) {
        // While placing, the changes the placement itself causes don't ask for another
        PLACE_POSTED.with(|p| p.set(true));
        self.take_prefs();
        self.place_guarded();
        if self.fold.to > 0.0 && self.glass_reads() {
            self.start_glass();
            self.render();
        }
        PLACE_POSTED.with(|p| p.set(false));
    }

    /** Takes the prefs (and Windows' light or dark) again, and sets what follows from them */
    fn take_prefs(&mut self) {
        self.prefs = crate::prefs();
        self.system_light = theme::apps_light();
        // The icons again: the choice, or the files in the icon folder, may have changed
        self.icons_stale = true;
        // A copy of the screen includes the notch (layered windows too, as the screen is composed): while the glass is set to read
        // what is behind, the notch is left out of copies, its own and screenshots alike. Where Windows can't (before Windows 10 2004,
        // where the same call blacks the window out of copies instead), the glass doesn't read
        let exclude = self.prefs.theme == Theme::Glass
            && self.prefs.glass_backdrop
            && theme::windows_build() >= 19_041;
        if exclude != self.excluded {
            let affinity = if exclude {
                WDA_EXCLUDEFROMCAPTURE
            } else {
                WDA_NONE
            };
            if unsafe { SetWindowDisplayAffinity(self.hwnd, affinity) }.is_ok() {
                self.excluded = exclude;
            }
            // Not set: still excluded when it was to be lifted (tried again at the next placement), not excluded when it was to
            // be set (the glass doesn't read)
        }
        let (fold_ms, move_ms) = if self.prefs.motion {
            (FOLD_MS, CARD_MOVE_MS)
        } else {
            (1.0, 1.0)
        };
        self.fold.ms = fold_ms;
        self.card_top.ms = move_ms;
        unsafe {
            if self.prefs.hide_fullscreen {
                SetTimer(Some(self.hwnd), T_FULL, FULL_MS, None);
            } else {
                let _ = KillTimer(Some(self.hwnd), T_FULL);
            }
        }
        if !self.prefs.hide_fullscreen {
            self.set_hidden(false);
        }
        if !self.glass_reads() {
            unsafe {
                let _ = KillTimer(Some(self.hwnd), T_GLASS);
            }
            self.glass.drop_backdrop();
        }
    }

    /** The colours now */
    fn pal(&self) -> Palette {
        theme::palette(&self.prefs, self.system_light, self.glass.has_backdrop())
    }

    /** Whether the glass reads what is behind it */
    fn glass_reads(&self) -> bool {
        self.prefs.theme == Theme::Glass
            && self.prefs.glass_backdrop
            && self.excluded
            && !self.hidden
    }

    /** Reads what is behind the window for the glass (kept in memory only) */
    fn take_backdrop(&mut self) {
        if !self.glass_reads()
            || self.size.0 <= 0
            || !self.surface_ready()
            || !self.glass.may_read(&self.gfx)
        {
            return;
        }
        let (w, h) = self.size;
        let dpi = self.draw_dpi();
        let taken = glass::capture(self.pos.x, self.pos.y, w, h)
            .map(|px| self.glass.set_backdrop(&self.gfx, &px, w, h, dpi));
        if !matches!(taken, Some(Ok(()))) {
            self.glass.drop_backdrop();
        }
    }

    /** The glass reads what is behind now and while the notch is open */
    fn start_glass(&mut self) {
        if self.glass_reads() {
            self.take_backdrop();
            unsafe { SetTimer(Some(self.hwnd), T_GLASS, GLASS_MS, None) };
        }
    }

    /** The DPI drawing is done at: the screen's, times the size in the prefs */
    fn draw_dpi(&self) -> f32 {
        self.dpi * self.prefs.scale()
    }

    /** Shown or hidden (while a full-screen app is in front) */
    fn set_hidden(&mut self, hide: bool) {
        if hide == self.hidden {
            return;
        }
        self.hidden = hide;
        unsafe {
            let _ = ShowWindow(self.hwnd, if hide { SW_HIDE } else { SW_SHOWNOACTIVATE });
        }
        if hide {
            self.glass.drop_backdrop();
        } else if self.fold.to > 0.0 {
            // Shown again while open: the glass reads again
            self.start_glass();
        }
    }

    fn place_guarded(&mut self) {
        // Only a placement shown on the screen tells the window's own DPI (it can differ from the monitor's reading on mixed
        // screens): placed again at it. A failed frame is drawn again soon, and its placement asked for again by the next change
        if !self.place_at(None) {
            return;
        }
        let own = unsafe { GetDpiForWindow(self.hwnd) } as f32;
        if own > 0.0 && own != self.dpi {
            self.place_at(Some(own));
        }
    }

    /** Sizes and places the window at a DPI (the monitor's when none), and shows it there; whether it was shown */
    fn place_at(&mut self, dpi: Option<f32>) -> bool {
        unsafe {
            let monitor = crate::screens::monitor_for(&self.prefs.display);
            self.monitor = monitor;
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return false;
            }
            let (mut dx, mut dy) = (96u32, 96u32);
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            let area = info.rcWork;
            let dpi = dpi.unwrap_or(dx as f32);
            let scale = dpi / 96.0 * self.prefs.scale();
            let scale_changed = self.dpi != dpi || self.scale != scale;
            self.dpi = dpi;
            self.scale = scale;
            let area_h = (area.bottom - area.top) as f32;
            self.win_h = WIN_H.min(area_h / self.scale);
            let (w, h) = (
                (WIN_W * self.scale).round() as i32,
                (self.win_h * self.scale).round() as i32,
            );
            self.pos = POINT {
                // Against the right edge always (on a work area narrower than the window, its clear left part goes past the
                // left edge; the pill stays on the screen, and the card too down to a work area about 330 DIP wide)
                x: area.right - w,
                y: area.top
                    + crate::prefs::along(self.prefs.position, area_h, h as f32, 0.0)
                        .0
                        .round() as i32,
            };
            self.size = (w, h);
            if scale_changed || self.surface.as_ref().map(|s| (s.w, s.h)) != Some((w, h)) {
                self.surface = None;
            }
            // What is behind was read at the old place
            self.glass.drop_backdrop();
        }
        self.render()
    }

    /** Takes the reader's state again and works out what to show */
    fn refresh_model(&mut self) {
        let snap = crate::snapshot();
        let now = crate::now_ms();
        let now_f = now as f64;
        self.view = match snap.mode {
            crate::Mode::Demo => model::sanitize_view(&crate::demo::body(now_f)).map(Arc::new),
            crate::Mode::Live => snap.view.clone(),
            crate::Mode::Setup => None,
        };
        let tz = jiff::tz::TimeZone::system();
        self.cells = self
            .view
            .as_ref()
            .map(|v| model::notch_model(v, now_f, &tz))
            .unwrap_or_default();
        self.footer = crate::footer(&snap, now);
        self.set_tick();
        crate::tray::set(model::tray_model(&self.cells, Some(&self.footer.0)));
        if self.card.is_some_and(|i| i >= self.cells.len().max(1)) {
            self.card = Some(0);
        }
    }

    fn set_tick(&mut self) {
        let waiting = self.card_at.is_some() || self.fold_at.is_some();
        let ms = if self.card.is_some() || waiting {
            1_000
        } else {
            30_000
        };
        if ms != self.tick_ms {
            // Counted as set only when it was: a later call tries again (every state change calls this)
            let set = unsafe { SetTimer(Some(self.hwnd), T_TICK, ms, None) } != 0;
            self.tick_ms = if set { ms } else { 0 };
        }
    }

    fn animate(&self) {
        unsafe { SetTimer(Some(self.hwnd), T_ANIM, 15, None) };
    }

    fn unfold(&mut self) {
        unsafe {
            let _ = KillTimer(Some(self.hwnd), T_FOLD);
        }
        if self.fold.to < 1.0 {
            self.fold.go(1.0);
            self.start_glass();
            self.animate();
        }
    }

    fn fold(&mut self) {
        if self.pinned {
            return;
        }
        self.card = None;
        self.fold.go(0.0);
        self.set_tick();
        self.animate();
    }

    fn show_card(&mut self, i: usize) {
        unsafe {
            let _ = KillTimer(Some(self.hwnd), T_CARD);
        }
        if self.card == Some(i) {
            return;
        }
        let target = self.card_target(i);
        if self.card.is_some() {
            self.card_top.go(target);
            self.animate();
        } else {
            self.card_top.jump(target);
        }
        self.card = Some(i);
        self.card_scroll = 0.0;
        // The card's times move every second while it shows
        self.refresh_model();
        self.set_tick();
        self.render();
    }

    fn hide_card(&mut self) {
        if self.pinned {
            return;
        }
        self.card = None;
        self.set_tick();
        self.render();
    }

    /** The rows of a cell's card that fit the window, and its height */
    fn card_fit(&self, i: usize) -> CardFit {
        card_fit(self.cells.get(i), self.win_h, self.card_scroll)
    }

    fn card_height(&self, i: usize) -> f32 {
        self.card_fit(i).h
    }

    /** Moves the card's rows (when they don't all fit) by a row: down for a negative delta, up for a positive one */
    fn wheel(&mut self, delta: i16) {
        let Some(i) = self.card else { return };
        let fit = self.card_fit(i);
        if !fit.scrolls {
            return;
        }
        let step = if delta < 0 { ROW_H } else { -ROW_H };
        let next = (fit.offset + step).clamp(0.0, fit.max);
        if next != fit.offset {
            self.card_scroll = next;
            self.render();
        }
    }

    /** The card's top for a cell: beside its ring, kept inside the window */
    fn card_target(&self, i: usize) -> f32 {
        let centre = self.layout().ring_centre(i.min(self.layout().n - 1));
        let h = self.card_height(i);
        (centre - h / 2.0).min(self.win_h - h - 8.0).max(8.0)
    }

    /** Makes what drawing needs when it is missing: a render target, the bitmap it draws into, and the icons on that target.
     * Drawing goes ahead only when all three are there */
    fn surface_ready(&mut self) -> bool {
        if self.target_lost {
            if self.gfx.renew(self.draw_dpi()).is_err() {
                return false;
            }
            self.target_lost = false;
            self.glass.reset();
            self.icons.clear();
            self.icons_stale = true;
            self.surface = None;
        }
        if self.surface.is_none() && self.size.0 > 0 {
            if let Ok(s) = Surface::new(self.size.0, self.size.1) {
                if self.gfx.bind(s.dc, s.w, s.h, self.draw_dpi()).is_ok() {
                    self.surface = Some(s);
                } else {
                    self.target_lost = true;
                    return false;
                }
            }
        }
        if self.surface.is_some() && self.icons_stale {
            self.load_icons();
            self.icons_stale = false;
        }
        self.surface.is_some()
    }

    /** A drawing or showing failure: all made again on the next try, which comes soon (a few times, then on the next change) */
    fn failed(&mut self) {
        self.failures += 1;
        self.target_lost = true;
        self.surface = None;
        if self.failures <= 3 {
            post_state();
        }
    }

    /** Draws and shows a frame; whether it was shown */
    fn render(&mut self) -> bool {
        if !self.surface_ready() {
            if self.failures < 3 {
                self.failures += 1;
                post_state();
            }
            return false;
        }
        let Some(s) = &self.surface else { return false };
        let (dc, w, h) = (s.dc, s.w, s.h);
        unsafe { self.gfx.rt.BeginDraw() };
        let painted = self.draw();
        let ended = unsafe { self.gfx.rt.EndDraw(None, None) };
        if painted.and(ended).is_err() {
            // The render target was lost (or a drawing call failed)
            self.failed();
            return false;
        }
        let shown = unsafe {
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            let screen = GetDC(None);
            let shown = UpdateLayeredWindow(
                self.hwnd,
                Some(screen),
                Some(&self.pos),
                Some(&SIZE { cx: w, cy: h }),
                Some(dc),
                Some(&POINT { x: 0, y: 0 }),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            ReleaseDC(None, screen);
            shown
        };
        if shown.is_err() {
            self.failed();
            return false;
        }
        self.failures = 0;
        // Development builds only: HEADROOM_DESKTOP_DUMP=<file> writes each frame shown (width, height, then premultiplied BGRA),
        // for checking a look that screen copies leave out
        #[cfg(debug_assertions)]
        if let (Some(path), Some(s)) = (std::env::var_os("HEADROOM_DESKTOP_DUMP"), &self.surface) {
            let n = (s.w * s.h * 4) as usize;
            let px = unsafe { std::slice::from_raw_parts(s.bits, n) };
            let mut out = Vec::with_capacity(n + 8);
            out.extend_from_slice(&(s.w as u32).to_le_bytes());
            out.extend_from_slice(&(s.h as u32).to_le_bytes());
            out.extend_from_slice(px);
            let _ = std::fs::write(path, out);
        }
        // The pointer is read at the scale of what is on the screen
        self.shown_scale = self.scale;
        true
    }

    fn draw(&mut self) -> Result<()> {
        let l = self.layout();
        let e = self.fold.value();
        let pal = self.pal();
        let g = &self.gfx;
        unsafe {
            g.rt.Clear(Some(&D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.0,
            }));
            g.rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            // Where the pointer is kept: an all but invisible margin (a fully clear pixel lets the pointer through)
            let hot = g.brush("#000000", 1.0 / 255.0)?;
            // The nub sits at the pill's middle
            let mid = l.pill_y + l.pill_h / 2.0;
            g.rt.FillRectangle(
                &rect(
                    WIN_W - NUB_HOT_W,
                    mid - NUB_H / 2.0 - HOT_PAD,
                    WIN_W,
                    mid + NUB_H / 2.0 + HOT_PAD,
                ),
                &hot,
            );
            if self.fold.to > 0.0 || e > 0.001 {
                g.rt.FillRectangle(
                    &rect(
                        l.pill_x - HOT_PAD,
                        l.pill_y - HOT_PAD,
                        WIN_W,
                        l.pill_y + l.pill_h + HOT_PAD,
                    ),
                    &hot,
                );
            }
            let card = self.card.filter(|_| e > 0.5);
            let card_top = if self.card_top.moving() {
                self.card_top.value()
            } else {
                card.map_or(0.0, |i| self.card_target(i))
            };
            let card_top = card.map_or(card_top, |i| {
                card_top
                    .min(self.win_h - self.card_height(i) - 8.0)
                    .max(8.0)
            });
            if let Some(i) = card {
                let ch = self.card_height(i);
                let right = WIN_W - CARD_RIGHT;
                g.rt.FillRectangle(
                    &rect(
                        right - CARD_W - HOT_PAD,
                        card_top - HOT_PAD,
                        l.pill_x,
                        card_top + ch + HOT_PAD,
                    ),
                    &hot,
                );
            }

            // The pill, opened from the nub: clipped to a box that grows from the nub to the whole pill
            if e > 0.001 {
                let lerp = |a: f32, b: f32| a + (b - a) * e;
                let clip = rect(
                    lerp(WIN_W - NUB_W, l.pill_x),
                    lerp(mid - NUB_H / 2.0, l.pill_y),
                    WIN_W,
                    lerp(mid + NUB_H / 2.0, l.pill_y + l.pill_h),
                );
                g.rt.PushAxisAlignedClip(&clip, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
                let drawn = (|| -> Result<()> {
                    let shape = pill_path(g, l.pill_x, l.pill_y, PILL_W, l.pill_h)?;
                    if pal.glass.is_some() {
                        // The bevel's inner edge: past the screen's edge, so no rim shows along it
                        let inner = g.rounded(
                            rect(
                                l.pill_x + BEVEL,
                                l.pill_y + FLARE + BEVEL,
                                WIN_W + 20.0,
                                l.pill_y + l.pill_h - FLARE - BEVEL,
                            ),
                            11.0,
                        )?;
                        self.glass.fill(
                            g,
                            &shape.cast()?,
                            Some(&inner.cast()?),
                            rect(l.pill_x, l.pill_y, WIN_W, l.pill_y + l.pill_h),
                            pal.pill,
                            1.0,
                        )?;
                    } else {
                        g.rt.FillGeometry(&shape, &g.ink(pal.pill, 1.0)?, None);
                    }
                    if self.cells.is_empty() {
                        let a = cell_alpha(e, 0);
                        let top = l.cell_top(0);
                        g.text(
                            "—",
                            &self.fmt.pct,
                            Place::at(l.pill_x, top + RING_PX / 2.0 - 8.0, PILL_W, PCT_LINE)
                                .align(DWRITE_TEXT_ALIGNMENT_CENTER)
                                .ink(pal.ink, a),
                        )?;
                    }
                    self.cells.iter().enumerate().try_for_each(|(i, c)| {
                        self.draw_cell(
                            &pal,
                            c,
                            l.pill_x + PILL_W / 2.0 + 10.0 * (1.0 - cell_alpha(e, i)),
                            l.cell_top(i),
                            cell_alpha(e, i),
                        )
                    })
                })();
                g.rt.PopAxisAlignedClip();
                drawn?;
            }
            // The nub fades in as the pill folds away (drawn past the edge, so only its left corners are round)
            let nub_a = (1.0 - e * 2.5).clamp(0.0, 1.0);
            if nub_a > 0.0 {
                let r = D2D1_ROUNDED_RECT {
                    rect: rect(
                        WIN_W - NUB_W,
                        mid - NUB_H / 2.0,
                        WIN_W + 6.0,
                        mid + NUB_H / 2.0,
                    ),
                    radiusX: 5.0,
                    radiusY: 5.0,
                };
                g.rt.FillRoundedRectangle(&r, &g.ink(pal.nub, nub_a)?);
            }
            if let Some(i) = card {
                self.draw_card(&pal, i, card_top, l.ring_centre(i.min(l.n - 1)))?;
            }
            Ok(())
        }
    }

    fn draw_cell(&self, pal: &Palette, c: &Cell, cx: f32, top: f32, a: f32) -> Result<()> {
        let g = &self.gfx;
        let k = RING_PX / VB;
        let cy = top + RING_PX / 2.0;
        let ring_a = a * if c.stale { 0.5 } else { 1.0 };
        unsafe {
            g.rt.DrawEllipse(
                &D2D1_ELLIPSE {
                    point: pt(cx, cy),
                    radiusX: RING_R * k,
                    radiusY: RING_R * k,
                },
                &g.ink(pal.track, ring_a)?,
                RING_STROKE * k,
                None,
            );
        }
        if let Some(h) = &c.headline {
            ring_arcs(
                g,
                cx,
                cy,
                RING_R * k,
                RING_STROKE * k,
                &h.pieces,
                c.color,
                ring_a,
            )?;
        }
        if let Some(w) = &c.weekly {
            unsafe {
                g.rt.DrawEllipse(
                    &D2D1_ELLIPSE {
                        point: pt(cx, cy),
                        radiusX: OUTER_R * k,
                        radiusY: OUTER_R * k,
                    },
                    &g.ink(pal.outer_track, ring_a)?,
                    OUTER_STROKE * k,
                    None,
                );
            }
            let p = &w.pieces;
            g.arc(
                cx,
                cy,
                OUTER_R * k,
                0.0,
                (p.solid + p.projected) as f32,
                OUTER_STROKE * k,
                c.color,
                0.6 * ring_a,
            )?;
        }
        if let Some((_, icon)) = self.icons.iter().find(|(p, _)| *p == c.provider) {
            let (bw, bh) = (icon.w * k, icon.h * k);
            unsafe {
                g.rt.DrawBitmap(
                    &icon.bitmap,
                    Some(&rect(
                        cx - bw / 2.0,
                        cy - bh / 2.0,
                        cx + bw / 2.0,
                        cy + bh / 2.0,
                    )),
                    ring_a,
                    D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
                    None,
                );
            }
        } else {
            g.text(
                mark_of(c.provider),
                &self.fmt.letter,
                Place::at(cx - 20.0, cy - 9.0, 40.0, 18.0)
                    .align(DWRITE_TEXT_ALIGNMENT_CENTER)
                    .color(c.color, ring_a),
            )?;
        }
        let (text, warn) = match &c.headline {
            Some(h) if h.warn => (format!("⚠ {}", h.text), true),
            Some(h) => (h.text.clone(), false),
            None => ("—".to_string(), false),
        };
        let place = Place::at(cx - PILL_W / 2.0, top + RING_PX + PCT_GAP, PILL_W, PCT_LINE)
            .align(DWRITE_TEXT_ALIGNMENT_CENTER);
        g.text(
            &text,
            &self.fmt.pct,
            place
                .ink(if warn { pal.warn } else { pal.ink }, a)
                .tabular(),
        )?;
        Ok(())
    }

    fn draw_card(&self, pal: &Palette, i: usize, top: f32, centre: f32) -> Result<()> {
        let g = &self.gfx;
        let h = self.card_height(i);
        let right = WIN_W - CARD_RIGHT;
        let left = right - CARD_W;
        unsafe {
            // The tail pointing at the ring
            let ty = top + 1.0 + (centre - top - 11.0).clamp(10.0, (h - 32.0).max(10.0));
            let tail = g.d2d.CreatePathGeometry()?;
            let s = tail.Open()?;
            let x = right - 1.0;
            s.BeginFigure(pt(x, ty), D2D1_FIGURE_BEGIN_FILLED);
            s.AddBezier(&D2D1_BEZIER_SEGMENT {
                point1: pt(x, ty + 6.0),
                point2: pt(x + 9.0, ty + 8.5),
                point3: pt(x + 12.0, ty + 11.0),
            });
            s.AddBezier(&D2D1_BEZIER_SEGMENT {
                point1: pt(x + 9.0, ty + 13.5),
                point2: pt(x, ty + 16.0),
                point3: pt(x, ty + 22.0),
            });
            s.EndFigure(D2D1_FIGURE_END_CLOSED);
            s.Close()?;
            let body = g.rounded(rect(left, top, right, top + h), 14.0)?;
            if pal.glass.is_some() {
                // One shape of the card and its tail
                let shape = g.d2d.CreatePathGeometry()?;
                let sink = shape.Open()?;
                body.CombineWithGeometry(&tail, D2D1_COMBINE_MODE_UNION, None, 0.25, &sink)?;
                sink.Close()?;
                let inner = g.rounded(
                    rect(left + BEVEL, top + BEVEL, right - BEVEL, top + h - BEVEL),
                    14.0 - BEVEL,
                )?;
                self.glass.fill(
                    g,
                    &shape.cast()?,
                    Some(&inner.cast()?),
                    rect(left, top, right, top + h),
                    pal.card,
                    1.0,
                )?;
            } else {
                g.rt.FillGeometry(&body, &g.ink(pal.card, 1.0)?, None);
                let inner = D2D1_ROUNDED_RECT {
                    rect: rect(left + 0.5, top + 0.5, right - 0.5, top + h - 0.5),
                    radiusX: 13.5,
                    radiusY: 13.5,
                };
                g.rt.DrawRoundedRectangle(&inner, &g.ink(pal.card_line, 1.0)?, 1.0, None);
                g.rt.FillGeometry(&tail, &g.ink(pal.card, 1.0)?, None);
            }
        }
        self.card_box.set(Some([left, top, right, top + h]));
        self.up_box.set(None);
        self.down_box.set(None);
        unsafe {
            g.rt.PushAxisAlignedClip(
                &rect(left, top, right, top + h),
                D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
            )
        };
        let inside = self.draw_card_body(pal, i, left, top);
        unsafe { g.rt.PopAxisAlignedClip() };
        inside
    }

    /** The card's text and bars (cut to the card) */
    fn draw_card_body(&self, pal: &Palette, i: usize, left: f32, top: f32) -> Result<()> {
        let g = &self.gfx;
        let x = left + 15.0;
        let w = CARD_W - 30.0;
        let mut y = top + 13.0;
        let f = &self.fmt;
        let c = self.cells.get(i);
        let name = c.map_or("Headroom", |c| c.name);
        let name_w = g.text(name, &f.name, Place::at(x, y, w, 18.9).ink(pal.ink, 1.0))?;
        if let Some(c) = c {
            if let Some(plan) = c.plan {
                g.text(
                    plan,
                    &f.small,
                    Place::at(x + name_w + 6.0, y + 3.5, w - name_w - 20.0, 16.0).ink(pal.dim, 1.0),
                )?;
            }
            unsafe {
                g.rt.FillEllipse(
                    &D2D1_ELLIPSE {
                        point: pt(x + w - 3.5, y + 10.5),
                        radiusX: 3.5,
                        radiusY: 3.5,
                    },
                    &g.brush(c.fresh.color, 1.0)?,
                );
            }
        }
        y += 18.9;
        if let Some(c) = c {
            if let Some(m) = c.message {
                y += 8.0;
                g.text(m, &f.body, Place::at(x, y, w, 16.2).ink(pal.ink_2, 1.0))?;
                y += 16.2;
            }
            let fit = self.card_fit(i);
            let all: f32 = c.rows.iter().map(row_height).sum();
            if !fit.scrolls && fit.area + 0.01 < all {
                y += 10.0;
                let notice = "Too little room here: see the tray menu";
                g.text(
                    notice,
                    &f.small,
                    Place::at(x, y + 1.0, w, 16.2).ink(pal.dim, 1.0),
                )?;
                y += 16.2;
                y += 11.0;
                unsafe {
                    g.rt.FillRectangle(&rect(x, y, x + w, y + 1.0), &g.ink(pal.card_line, 1.0)?)
                };
                y += 9.0;
                g.text(
                    &self.footer.0,
                    &f.small,
                    Place::at(x, y, w, 14.85)
                        .ink(if self.footer.1 { pal.warn } else { pal.dim }, 1.0),
                )?;
                return Ok(());
            }
            // The line for the rows above (dim when there are none to move to)
            if fit.scrolls {
                y += 10.0;
                let can = fit.offset > 0.0;
                if can {
                    self.up_box.set(Some([x, y - 5.0, x + w, y + 21.2]));
                }
                let a = if can { 1.0 } else { 0.35 };
                g.text(
                    "↑ more",
                    &f.small,
                    Place::at(x, y + 1.0, w, 16.2).ink(pal.dim, a),
                )?;
                y += 16.2;
            }
            // The rows, cut to their room
            let rows_top = y;
            unsafe {
                g.rt.PushAxisAlignedClip(
                    &rect(left, rows_top, left + CARD_W, rows_top + fit.area),
                    D2D1_ANTIALIAS_MODE_ALIASED,
                )
            };
            let drawn = (|| -> Result<()> {
                let mut y = rows_top - fit.offset;
                for r in &c.rows {
                    // Only the rows that reach into the room are drawn
                    if y + row_height(r) <= rows_top || y >= rows_top + fit.area {
                        y += row_height(r);
                        continue;
                    }
                    y += 10.0;
                    match r {
                        CardRow::Missing { label, text, .. } => {
                            let tw = g.width(text, &f.small, true)?;
                            g.text(
                                label,
                                &f.body,
                                Place::at(x, y, w - tw - 8.0, 16.2).ink(pal.dim, 1.0),
                            )?;
                            g.text(
                                text,
                                &f.small,
                                Place::at(x, y + 1.0, w, 16.2)
                                    .align(DWRITE_TEXT_ALIGNMENT_TRAILING)
                                    .ink(pal.dim, 1.0)
                                    .tabular(),
                            )?;
                            y += 16.2;
                        }
                        CardRow::Limit {
                            label,
                            left,
                            pace,
                            time,
                            warn,
                            pieces,
                            ..
                        } => {
                            let tw = g.width(time, &f.small, true)?;
                            g.text(
                                label,
                                &f.label,
                                Place::at(x, y, w - tw - 8.0, 16.2).ink(pal.ink, 1.0),
                            )?;
                            let tc = if *warn { pal.warn } else { pal.dim };
                            g.text(
                                time,
                                &f.small,
                                Place::at(x, y + 1.0, w, 16.2)
                                    .align(DWRITE_TEXT_ALIGNMENT_TRAILING)
                                    .ink(tc, 1.0)
                                    .tabular(),
                            )?;
                            y += 16.2 + 5.0;
                            bar(g, pal, x, y, w, pieces, c.color)?;
                            y += 5.0 + 4.0;
                            g.text(
                                left,
                                &f.small,
                                Place::at(x, y, w, 14.85).ink(pal.ink_2, 1.0).tabular(),
                            )?;
                            g.text(
                                pace,
                                &f.small,
                                Place::at(x, y, w, 14.85)
                                    .align(DWRITE_TEXT_ALIGNMENT_TRAILING)
                                    .ink(pal.dim, 1.0)
                                    .tabular(),
                            )?;
                            y += 14.85;
                        }
                    }
                }
                Ok(())
            })();
            unsafe { g.rt.PopAxisAlignedClip() };
            drawn?;
            y = rows_top + fit.area;
            // The line for the rows below
            if fit.scrolls {
                y += 10.0;
                let can = fit.offset < fit.max;
                if can {
                    self.down_box.set(Some([x, y - 5.0, x + w, y + 21.2]));
                }
                let a = if can { 1.0 } else { 0.35 };
                g.text(
                    "↓ more",
                    &f.small,
                    Place::at(x, y + 1.0, w, 16.2).ink(pal.dim, a),
                )?;
                y += 16.2;
            }
        }
        y += 11.0;
        unsafe {
            g.rt.FillRectangle(&rect(x, y, x + w, y + 1.0), &g.ink(pal.card_line, 1.0)?)
        };
        y += 9.0;
        let note = self
            .note
            .as_ref()
            .filter(|(_, at)| at.elapsed().as_millis() < NOTE_MS);
        let (text, warn) = note.map_or((self.footer.0.as_str(), self.footer.1), |(n, _)| {
            (n.as_str(), false)
        });
        g.text(
            text,
            &f.small,
            Place::at(x, y, w, 14.85).ink(if warn { pal.warn } else { pal.dim }, 1.0),
        )?;
        Ok(())
    }

    /** Asks Windows to say when the pointer leaves (once per entry) */
    fn track(&mut self) {
        if !self.tracking {
            let mut t = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: self.hwnd,
                dwHoverTime: 0,
            };
            self.tracking = unsafe { TrackMouseEvent(&mut t) }.is_ok();
        }
    }

    fn mouse_move(&mut self, x: f32, y: f32) {
        self.track();
        self.card_at = None;
        self.fold_at = None;
        unsafe {
            let _ = KillTimer(Some(self.hwnd), T_FOLD);
            let _ = KillTimer(Some(self.hwnd), T_CARD);
        }
        // Opened by a click: the pointer alone doesn't open it
        if self.prefs.open_on == OpenOn::Click && self.fold.to < 1.0 {
            return;
        }
        self.unfold();
        let l = self.layout();
        if self.cells.is_empty() {
            if x >= l.pill_x {
                self.show_card(0);
            }
        } else if let Some(i) = l.cell_at(x, y) {
            self.show_card(i);
        }
    }

    /** A leave taken late: only when the pointer really is elsewhere now */
    fn leave_if_outside(&mut self) {
        let mut at = POINT::default();
        let inside = unsafe { GetCursorPos(&mut at).is_ok() && WindowFromPoint(at) == self.hwnd };
        if inside {
            // Still over the notch (the move that came back was missed): nothing goes, and the leave is watched for again
            self.tracking = false;
            self.track();
            self.card_at = None;
            self.fold_at = None;
        } else {
            self.mouse_leave();
        }
    }

    fn mouse_leave(&mut self) {
        self.tracking = false;
        if !self.pinned {
            let now = Instant::now();
            let (card_ms, fold_ms) = self.prefs.graces();
            self.card_at = Some(now + std::time::Duration::from_millis(card_ms.into()));
            self.fold_at = Some(now + std::time::Duration::from_millis(fold_ms.into()));
            let card = unsafe { SetTimer(Some(self.hwnd), T_CARD, card_ms, None) } != 0;
            let fold = unsafe { SetTimer(Some(self.hwnd), T_FOLD, fold_ms, None) } != 0;
            let set = card && fold;
            if !set {
                // The tick takes the deadlines instead
                self.tick_ms = 0;
                self.set_tick();
            }
        }
    }

    /** A click on a ring reads the server now, or says when it next may */
    fn click(&mut self, x: f32, y: f32) {
        if self.prefs.open_on == OpenOn::Click && self.fold.to < 1.0 {
            self.unfold();
            self.mouse_move(x, y);
            return;
        }
        let within =
            |b: Option<[f32; 4]>| b.is_some_and(|b| x >= b[0] && x < b[2] && y >= b[1] && y < b[3]);
        // The card's lines for the rows above and below move them (where the wheel doesn't reach an inactive window)
        if self.card.is_some() && within(self.up_box.get()) {
            self.wheel(1);
            return;
        }
        if self.card.is_some() && within(self.down_box.get()) {
            self.wheel(-1);
            return;
        }
        let l = self.layout();
        if l.cell_at(x, y).is_none() && !(self.cells.is_empty() && x >= l.pill_x) {
            return;
        }
        let minutes = crate::refresh_now();
        if minutes > 0 {
            self.note = Some((format!("Next read in {minutes} min"), Instant::now()));
            self.render();
        }
    }

    /** Whether a deadline has come. A timer may fire a little before it: then it is set again for the time left */
    fn due(&self, id: usize, at: Option<Instant>) -> bool {
        let Some(at) = at else { return false };
        let now = Instant::now();
        if now >= at {
            return true;
        }
        let left = (at - now).as_millis().clamp(1, u32::MAX as u128) as u32;
        unsafe { SetTimer(Some(self.hwnd), id, left, None) };
        false
    }

    fn timer(&mut self, id: usize) {
        match id {
            T_ANIM => {
                if !self.fold.moving() && !self.card_top.moving() {
                    unsafe {
                        let _ = KillTimer(Some(self.hwnd), T_ANIM);
                    }
                }
                self.render();
            }
            T_FOLD => {
                unsafe {
                    let _ = KillTimer(Some(self.hwnd), T_FOLD);
                }
                if self.due(T_FOLD, self.fold_at) {
                    self.fold_at = None;
                    self.fold();
                }
            }
            T_CARD => {
                unsafe {
                    let _ = KillTimer(Some(self.hwnd), T_CARD);
                }
                if self.due(T_CARD, self.card_at) {
                    self.card_at = None;
                    self.hide_card();
                }
            }
            T_FULL => {
                let covered = self.prefs.hide_fullscreen
                    && crate::screens::fullscreen_on(self.monitor, self.hwnd);
                self.set_hidden(covered);
            }
            T_GLASS => {
                if self.fold.to <= 0.0 && !self.fold.moving() || !self.glass_reads() {
                    // Folded: what is behind isn't read until it opens again
                    unsafe {
                        let _ = KillTimer(Some(self.hwnd), T_GLASS);
                    }
                    self.glass.drop_backdrop();
                } else {
                    self.take_backdrop();
                    self.render();
                }
            }
            T_TICK => {
                // A leave Windows didn't report (watching it couldn't be asked for): the pointer is looked for here
                if !self.pinned && self.fold.to > 0.0 && self.fold_at.is_none() && !self.tracking {
                    let mut at = POINT::default();
                    let inside = unsafe {
                        GetCursorPos(&mut at).is_ok() && WindowFromPoint(at) == self.hwnd
                    };
                    if !inside {
                        self.mouse_leave();
                    }
                }
                if self.fold_at.is_some_and(|at| Instant::now() >= at) {
                    self.fold_at = None;
                    self.fold();
                }
                if self.card_at.is_some_and(|at| Instant::now() >= at) {
                    self.card_at = None;
                    self.card = None;
                    self.set_tick();
                }
                self.refresh_model();
                self.render();
            }
            _ => {}
        }
    }
}

/** A cell's opacity as the pill opens: each cell a little after the one above it */
fn cell_alpha(e: f32, i: usize) -> f32 {
    ((e * FOLD_MS - i as f32 * 30.0) / 180.0).clamp(0.0, 1.0)
}

/** A ring's arcs from 12 o'clock: likely left after the reset (solid), likely used before it (light), recent use (gray) */
#[allow(clippy::too_many_arguments)]
fn ring_arcs(
    g: &Gfx,
    cx: f32,
    cy: f32,
    r: f32,
    w: f32,
    p: &Pieces,
    hex: &str,
    a: f32,
) -> Result<()> {
    let fade = a * if p.faded { 0.45 } else { 1.0 };
    let (solid, projected, recent) = (p.solid as f32, p.projected as f32, p.recent as f32);
    g.arc(cx, cy, r, 0.0, solid, w, hex, fade)?;
    g.arc(cx, cy, r, solid, solid + projected, w, hex, 0.35 * fade)?;
    g.arc(
        cx,
        cy,
        r,
        solid + projected,
        solid + projected + recent,
        w,
        RECENT,
        fade,
    )
}

/** A card's bar: the track, then the same three pieces from the left, cut to the track's rounded shape */
fn bar(g: &Gfx, pal: &Palette, x: f32, y: f32, w: f32, p: &Pieces, hex: &str) -> Result<()> {
    let track = rect(x, y, x + w, y + 5.0);
    let shape = g.rounded(track, 2.5)?;
    unsafe { g.rt.FillGeometry(&shape, &g.ink(pal.card_line, 1.0)?, None) };
    g.push_mask(&shape.into());
    let fade = if p.faded { 0.45 } else { 1.0 };
    let mut bx = x;
    let filled = [
        (p.solid, hex, fade),
        (p.projected, hex, 0.35 * fade),
        (p.recent, RECENT, fade),
    ]
    .into_iter()
    .try_for_each(|(frac, color, a)| {
        let bw = frac as f32 * w;
        if frac > 0.0005 {
            unsafe {
                g.rt.FillRectangle(&rect(bx, y, bx + bw, y + 5.0), &g.brush(color, a)?)
            };
        }
        bx += bw;
        Ok(())
    });
    // Always taken off, so the drawing stays balanced when a piece fails
    g.pop_layer();
    filled
}

/** The pill's outline: a rounded body with flares curving into the screen edge at the top and the bottom */
fn pill_path(g: &Gfx, x0: f32, y0: f32, w: f32, h: f32) -> Result<ID2D1PathGeometry> {
    let f = FLARE;
    let r = 18f32.min((w - 1.0) / 2.0);
    unsafe {
        let geo = g.d2d.CreatePathGeometry()?;
        let s = geo.Open()?;
        let p = |x: f32, y: f32| pt(x0 + x, y0 + y);
        let arc = |to| D2D1_ARC_SEGMENT {
            point: to,
            size: D2D_SIZE_F {
                width: f,
                height: f,
            },
            rotationAngle: 0.0,
            sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
            arcSize: D2D1_ARC_SIZE_SMALL,
        };
        s.BeginFigure(p(w, 0.0), D2D1_FIGURE_BEGIN_FILLED);
        s.AddArc(&arc(p(w - f, f)));
        s.AddLine(p(r, f));
        s.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT {
            point1: p(0.0, f),
            point2: p(0.0, f + r),
        });
        s.AddLine(p(0.0, h - f - r));
        s.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT {
            point1: p(0.0, h - f),
            point2: p(r, h - f),
        });
        s.AddLine(p(w - f, h - f));
        s.AddArc(&arc(p(w, h)));
        s.EndFigure(D2D1_FIGURE_END_CLOSED);
        s.Close()?;
        Ok(geo)
    }
}

fn with<R>(f: impl FnOnce(&mut Notch) -> R) -> Option<R> {
    NOTCH.with(|n| n.try_borrow_mut().ok().and_then(|mut n| n.as_mut().map(f)))
}

fn point_of(lp: LPARAM, scale: f32) -> (f32, f32) {
    let x = (lp.0 & 0xffff) as i16 as f32;
    let y = ((lp.0 >> 16) & 0xffff) as i16 as f32;
    (x / scale, y / scale)
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let handled = match msg {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_MOUSEMOVE => with(|n| {
            let (x, y) = point_of(lp, n.shown_scale);
            n.mouse_move(x, y);
        }),
        WM_MOUSELEAVE => with(Notch::leave_if_outside),
        WM_LBUTTONUP => with(|n| {
            let (x, y) = point_of(lp, n.shown_scale);
            n.click(x, y);
        }),
        WM_TIMER => with(|n| n.timer(wp.0)),
        // The wheel over the card (its point is on the screen)
        WM_MOUSEWHEEL => with(|n| {
            let mut at = POINT {
                x: (lp.0 & 0xffff) as i16 as i32,
                y: ((lp.0 >> 16) & 0xffff) as i16 as i32,
            };
            if unsafe { ScreenToClient(n.hwnd, &mut at) }.as_bool() {
                let (x, y) = (at.x as f32 / n.shown_scale, at.y as f32 / n.shown_scale);
                if n.card_box
                    .get()
                    .is_some_and(|b| x >= b[0] && x < b[2] && y >= b[1] && y < b[3])
                {
                    n.wheel(((wp.0 >> 16) & 0xffff) as u16 as i16);
                }
            }
        }),
        crate::WM_APP_STATE => with(|n| {
            n.refresh_model();
            n.render();
        }),
        WM_APP_PLACE => with(Notch::place),
        WM_APP_DRAIN => {
            DRAIN_POSTED.with(|d| d.set(false));
            Some(())
        }
        // The screen, its scale or the work area (the taskbar) changed: placed again once the change has settled
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE => {
            if !PLACE_POSTED.with(|p| p.replace(true)) {
                let posted =
                    unsafe { PostMessageW(Some(hwnd), WM_APP_PLACE, WPARAM(0), LPARAM(0)) };
                if posted.is_err() {
                    PLACE_POSTED.with(|p| p.set(false));
                }
            }
            None
        }
        WM_POWERBROADCAST => {
            // Back from sleep: read again when the schedule allows it
            crate::nudge();
            None
        }
        _ => None,
    };
    if handled.is_some() {
        drain_pending();
        return LRESULT(0);
    }
    // Busy with an update that a Win32 call came back into: kept as pending work, done when the update ends (a timer comes again,
    // a move or a click is the user's to repeat)
    let busy = NOTCH.with(|n| n.try_borrow_mut().is_err());
    let pending = match msg {
        crate::WM_APP_STATE => P_STATE,
        WM_APP_PLACE => P_PLACE,
        WM_MOUSELEAVE => P_LEAVE,
        _ => 0,
    };
    if busy && pending != 0 {
        PENDING.with(|p| p.set(p.get() | pending));
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

/** Does the work that came in while the notch was busy: one round, and what comes in during it is left for one posted message
 * (so the message loop always gets its turn) */
fn drain_pending() {
    {
        let bits = PENDING.with(|p| p.replace(0));
        if bits == 0 {
            return;
        }
        let done = with(|n| {
            if bits & P_PLACE != 0 {
                n.place();
            }
            if bits & P_STATE != 0 {
                n.refresh_model();
                n.render();
            }
            if bits & P_LEAVE != 0 {
                n.leave_if_outside();
            }
        });
        if done.is_none() {
            // Still busy (called from inside an update): left for the update's own end
            PENDING.with(|p| p.set(p.get() | bits));
            return;
        }
    }
    if PENDING.with(|p| p.get()) != 0 && !DRAIN_POSTED.with(|d| d.get()) {
        let h = HWND_VALUE.load(Ordering::SeqCst);
        let posted =
            unsafe { PostMessageW(Some(HWND(h as *mut _)), WM_APP_DRAIN, WPARAM(0), LPARAM(0)) };
        // Not sent: the next message the notch handles does it
        DRAIN_POSTED.with(|d| d.set(posted.is_ok()));
    }
}

/** Makes the notch window and shows it */
pub fn create(pinned: bool) -> Result<()> {
    unsafe {
        let hinst = GetModuleHandleW(None)?;
        let class = w!("HeadroomNotch");
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            ..Default::default()
        });
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("Headroom"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(hinst.into()),
            None,
        )?;
        HWND_VALUE.store(hwnd.0 as isize, Ordering::SeqCst);
        let gfx = Gfx::new(96.0)?;
        let fmt = formats(&gfx)?;
        let mut notch = Notch {
            hwnd,
            gfx,
            fmt,
            surface: None,
            dpi: 96.0,
            scale: 1.0,
            shown_scale: 1.0,
            win_h: WIN_H,
            pos: POINT::default(),
            icons: Vec::new(),
            view: None,
            cells: Vec::new(),
            footer: (String::new(), false),
            note: None,
            fold: Anim::still(if pinned { 1.0 } else { 0.0 }, FOLD_MS),
            card: pinned.then_some(0),
            card_top: Anim::still(0.0, CARD_MOVE_MS),
            tracking: false,
            card_at: None,
            fold_at: None,
            card_scroll: 0.0,
            card_box: std::cell::Cell::new(None),
            up_box: std::cell::Cell::new(None),
            down_box: std::cell::Cell::new(None),
            size: (0, 0),
            failures: 0,
            target_lost: false,
            icons_stale: false,
            pinned,
            tick_ms: 0,
            prefs: Prefs::default(),
            system_light: false,
            glass: Glass::default(),
            monitor: HMONITOR::default(),
            hidden: false,
            excluded: false,
        };
        notch.load_icons();
        notch.refresh_model();
        notch.set_tick();
        NOTCH.with(|n| *n.borrow_mut() = Some(notch));
        with(Notch::place);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

/** Asks the notch to take the prefs again and place itself (a burst of asks places once) */
pub fn post_place() {
    let h = HWND_VALUE.load(Ordering::SeqCst);
    if h == 0 || PLACE_POSTED.with(|p| p.replace(true)) {
        return;
    }
    let posted =
        unsafe { PostMessageW(Some(HWND(h as *mut _)), WM_APP_PLACE, WPARAM(0), LPARAM(0)) };
    if posted.is_err() {
        PLACE_POSTED.with(|p| p.set(false));
    }
}

/** Asks the notch (from any thread) to take the state again */
pub fn post_state() {
    let h = HWND_VALUE.load(Ordering::SeqCst);
    if h != 0 {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(h as *mut _)),
                crate::WM_APP_STATE,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_are_sized_as_the_widget_sizes_them() {
        assert_eq!(icon_box(1.0, 19.0), (19.0, 19.0));
        let (w, h) = icon_box(4.0, 19.0);
        assert!(
            (w - 28.5).abs() < 1e-4 && (h - 7.125).abs() < 1e-4,
            "a wide one is at most 1.5 × as wide"
        );
        assert_eq!(icon_box(0.5, 19.0), (9.5, 19.0));
        assert_eq!(png_aspect(b"nope"), 1.0);
    }

    /** Every row of the sample's cards can be reached whole at any window height, with no failure */
    #[test]
    fn every_row_can_be_reached_however_short_the_window() {
        let now = 1_794_834_300_000.0;
        let view = model::sanitize_view(&crate::demo::body(now)).unwrap();
        let cells = model::notch_model(&view, now, &jiff::tz::TimeZone::UTC);
        for c in &cells {
            let all: f32 = c.rows.iter().map(row_height).sum();
            for win_h in (60..=700).step_by(2).map(|h| h as f32) {
                let fit = card_fit(Some(c), win_h, 0.0);
                if win_h >= MIN_SCROLL_WIN_H {
                    assert!(
                        fit.h <= win_h - 16.0 + 1e-3,
                        "{} at {win_h}: {}",
                        c.name,
                        fit.h
                    );
                }
                if !fit.scrolls && fit.area + 0.01 < all {
                    assert!(win_h < MIN_SCROLL_WIN_H, "the notice only below 300 DIP");
                    continue;
                }
                if !fit.scrolls {
                    assert!((fit.area - all).abs() < 1e-3 && fit.h <= win_h - 16.0 + 1e-3);
                    continue;
                }
                // Scrolled to the end, the last row is whole in the room; and at the start, the first
                let end = card_fit(Some(c), win_h, f32::MAX);
                assert!(
                    (end.offset + end.area - all).abs() < 1e-3 || end.area >= all,
                    "{} at {win_h}",
                    c.name
                );
                assert!(fit.area >= ROW_H - 1e-3, "at least a row's room at {win_h}");
                // From 300 DIP the card, its lines and its footer are inside the window
            }
        }
        assert_eq!(card_fit(None, 100.0, 5.0).offset, 0.0);
    }

    #[test]
    fn the_easing_runs_from_0_to_1() {
        assert!(ease(0.0).abs() < 1e-3 && (ease(1.0) - 1.0).abs() < 1e-3);
        assert!(ease(0.5) > 0.5, "it starts fast and settles");
    }
}
