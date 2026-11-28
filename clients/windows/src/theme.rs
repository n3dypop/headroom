//! The notch's colours for each theme: a colour and how opaque it is.

use crate::prefs::{Prefs, Theme, Tint};
use windows::core::w;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

/** A colour ("#rrggbb") and its opacity */
pub type Ink = (&'static str, f32);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub ink: Ink,
    pub ink_2: Ink,
    pub dim: Ink,
    pub warn: Ink,
    /// A ring's track, and the weekly ring's
    pub track: Ink,
    pub outer_track: Ink,
    /// The pill's and the card's fill (on glass: the film over what is behind)
    pub pill: Ink,
    pub card: Ink,
    pub card_line: Ink,
    pub nub: Ink,
    /// Drawn as glass (with this tint)
    pub glass: Option<Tint>,
}

pub const DARK: Palette = Palette {
    ink: ("#ffffff", 1.0),
    ink_2: ("#c9c9ce", 1.0),
    dim: ("#8e8e93", 1.0),
    warn: ("#ffd60a", 1.0),
    track: ("#2a2a2d", 1.0),
    outer_track: ("#1c1c1f", 1.0),
    pill: ("#000000", 1.0),
    card: ("#0c0c0d", 1.0),
    card_line: ("#26262a", 1.0),
    nub: ("#3a3a3e", 1.0),
    glass: None,
};

pub const LIGHT: Palette = Palette {
    ink: ("#1d1d1f", 1.0),
    ink_2: ("#3a3a3c", 1.0),
    dim: ("#6e6e73", 1.0),
    warn: ("#b26a00", 1.0),
    track: ("#dcdce0", 1.0),
    outer_track: ("#ececef", 1.0),
    pill: ("#f5f5f7", 1.0),
    card: ("#ffffff", 1.0),
    card_line: ("#e3e3e7", 1.0),
    nub: ("#b8b8bd", 1.0),
    glass: None,
};

/** Glass with white text (clear and dark tints): the lines are white, partly clear */
const GLASS_WHITE: Palette = Palette {
    ink: ("#ffffff", 1.0),
    ink_2: ("#ffffff", 0.86),
    dim: ("#ffffff", 0.64),
    warn: ("#ffd60a", 1.0),
    track: ("#ffffff", 0.20),
    outer_track: ("#ffffff", 0.12),
    pill: ("#16161a", 0.20),
    card: ("#16161a", 0.20),
    card_line: ("#ffffff", 0.18),
    nub: ("#ffffff", 0.50),
    glass: Some(Tint::Clear),
};

/** Glass with dark text (the light tint) */
const GLASS_BLACK: Palette = Palette {
    ink: ("#111114", 1.0),
    ink_2: ("#111114", 0.82),
    dim: ("#111114", 0.58),
    warn: ("#9a5b00", 1.0),
    track: ("#000000", 0.14),
    outer_track: ("#000000", 0.08),
    pill: ("#ffffff", 0.52),
    card: ("#ffffff", 0.52),
    card_line: ("#000000", 0.12),
    nub: ("#000000", 0.30),
    glass: Some(Tint::Light),
};

/** Windows' build number (0 when it can't be read) */
pub fn windows_build() -> u32 {
    let mut buf = [0u16; 32];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let got = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if got.is_err() {
        return 0;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..n])
        .trim()
        .parse()
        .unwrap_or(0)
}

/** Whether Windows' apps are set to light (the System theme follows it) */
pub fn apps_light() -> bool {
    let mut v: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let got = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut v as *mut u32).cast()),
            Some(&mut size),
        )
    };
    got.is_ok() && v != 0
}

/** The colours for the prefs. On glass, `backdrop` says whether what is behind is blurred under it (the film can be lighter)
 * or shows through as it is (the film is denser, so the text stays readable) */
pub fn palette(p: &Prefs, system_light: bool, backdrop: bool) -> Palette {
    match p.theme {
        Theme::Dark => DARK,
        Theme::Light => LIGHT,
        Theme::System if system_light => LIGHT,
        Theme::System => DARK,
        Theme::Glass => {
            let (base, film) = match (p.glass_tint, backdrop) {
                (Tint::Clear, true) => (GLASS_WHITE, ("#16161a", 0.20)),
                (Tint::Clear, false) => (GLASS_WHITE, ("#16161a", 0.72)),
                (Tint::Dark, true) => (GLASS_WHITE, ("#0b0b10", 0.52)),
                (Tint::Dark, false) => (GLASS_WHITE, ("#0b0b10", 0.86)),
                (Tint::Light, true) => (GLASS_BLACK, ("#ffffff", 0.50)),
                (Tint::Light, false) => (GLASS_BLACK, ("#ffffff", 0.84)),
            };
            Palette {
                pill: film,
                card: film,
                glass: Some(p.glass_tint),
                ..base
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_theme_has_its_colours() {
        let p = |theme| Prefs {
            theme,
            ..Prefs::default()
        };
        assert_eq!(palette(&p(Theme::Dark), true, true), DARK);
        assert_eq!(palette(&p(Theme::System), true, true), LIGHT);
        assert_eq!(palette(&p(Theme::System), false, true), DARK);
        let glass = palette(&p(Theme::Glass), false, true);
        assert_eq!(glass.glass, Some(Tint::Clear));
        assert!(
            palette(&p(Theme::Glass), false, false).pill.1 > glass.pill.1,
            "denser without what is behind blurred"
        );
        let light = Prefs {
            theme: Theme::Glass,
            glass_tint: Tint::Light,
            ..Prefs::default()
        };
        assert_eq!(palette(&light, false, true).ink.0, "#111114");
    }
}
