//! How the notch looks and behaves: kept in desktop.json beside the server (the macOS client reads and writes the same keys).
//! Each key is read on its own: a value of the wrong type or an unknown one gives that key its default, and never touches the
//! server or the token.

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    Small,
    Normal,
    Large,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    /// Light or dark as Windows' apps are
    System,
    Dark,
    Light,
    /// Liquid glass
    Glass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tint {
    Clear,
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenOn {
    Hover,
    Click,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldDelay {
    Short,
    Normal,
    Long,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prefs {
    /// The screen the notch goes on ("" for the one furthest right): the monitor's device name, as \\.\DISPLAY2
    pub display: String,
    /// Along the edge: 0 at the top, 50 in the middle, 100 at the bottom
    pub position: u8,
    pub size: Size,
    pub theme: Theme,
    /// The glass reads what is behind it (while open, in memory only) to blur and bend it; else it only looks like glass
    pub glass_backdrop: bool,
    pub glass_tint: Tint,
    pub open_on: OpenOn,
    pub fold_delay: FoldDelay,
    /// The notch opens, folds and moves its card with animations (else at once)
    pub motion: bool,
    /// Hidden while a full-screen app is in front on its screen
    pub hide_fullscreen: bool,
    /// The providers whose second icon is used (as on the widget), in the providers' order
    pub alt_icons: Vec<&'static str>,
}

impl Default for Prefs {
    fn default() -> Prefs {
        Prefs {
            display: String::new(),
            position: 50,
            size: Size::Normal,
            theme: Theme::Dark,
            glass_backdrop: true,
            glass_tint: Tint::Clear,
            open_on: OpenOn::Hover,
            fold_delay: FoldDelay::Normal,
            motion: true,
            hide_fullscreen: true,
            alt_icons: Vec::new(),
        }
    }
}

/** The names in a list that are providers, once each, in the providers' order (a list of anything else gives none) */
fn providers_in(v: Option<&Value>) -> Vec<&'static str> {
    let Some(list) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    crate::model::PROVIDER_ORDER
        .into_iter()
        .filter(|p| list.iter().any(|x| x.as_str() == Some(p)))
        .collect()
}

/** A key's value among the names it may have, as its own value (None for a missing, unknown or wrong-typed one) */
fn named<T: Copy>(v: &Map<String, Value>, key: &str, names: &[(&str, T)]) -> Option<T> {
    let s = v.get(key)?.as_str()?;
    names.iter().find(|(n, _)| *n == s).map(|(_, t)| *t)
}

fn name_of<T: PartialEq>(t: T, names: &[(&'static str, T)]) -> &'static str {
    names.iter().find(|(_, n)| *n == t).map_or("", |(s, _)| s)
}

const SIZES: [(&str, Size); 3] = [
    ("small", Size::Small),
    ("normal", Size::Normal),
    ("large", Size::Large),
];
const THEMES: [(&str, Theme); 4] = [
    ("system", Theme::System),
    ("dark", Theme::Dark),
    ("light", Theme::Light),
    ("glass", Theme::Glass),
];
const TINTS: [(&str, Tint); 3] = [
    ("clear", Tint::Clear),
    ("dark", Tint::Dark),
    ("light", Tint::Light),
];
const OPENS: [(&str, OpenOn); 2] = [("hover", OpenOn::Hover), ("click", OpenOn::Click)];
const DELAYS: [(&str, FoldDelay); 3] = [
    ("short", FoldDelay::Short),
    ("normal", FoldDelay::Normal),
    ("long", FoldDelay::Long),
];

impl Prefs {
    /** The prefs in a settings file's object (each key its default when it can't be taken) */
    pub fn from_value(v: &Value) -> Prefs {
        let d = Prefs::default();
        let Some(v) = v.as_object() else { return d };
        let flag =
            |key: &str, default: bool| v.get(key).and_then(Value::as_bool).unwrap_or(default);
        Prefs {
            display: v
                .get("display")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 64)
                .unwrap_or("")
                .to_string(),
            position: v
                .get("position")
                // A whole number, also when written as 37.0
                .and_then(Value::as_f64)
                .filter(|&p| (0.0..=100.0).contains(&p) && p.fract() == 0.0)
                .map_or(d.position, |p| p as u8),
            size: named(v, "size", &SIZES).unwrap_or(d.size),
            theme: named(v, "theme", &THEMES).unwrap_or(d.theme),
            glass_backdrop: flag("glass_backdrop", d.glass_backdrop),
            glass_tint: named(v, "glass_tint", &TINTS).unwrap_or(d.glass_tint),
            open_on: named(v, "open_on", &OPENS).unwrap_or(d.open_on),
            fold_delay: named(v, "fold_delay", &DELAYS).unwrap_or(d.fold_delay),
            motion: flag("motion", d.motion),
            hide_fullscreen: flag("hide_fullscreen", d.hide_fullscreen),
            alt_icons: providers_in(v.get("alt_icons")),
        }
    }

    /** Writes the prefs into a settings file's object */
    pub fn write_into(&self, v: &mut Map<String, Value>) {
        v.insert("display".into(), self.display.clone().into());
        v.insert("position".into(), self.position.into());
        v.insert("size".into(), name_of(self.size, &SIZES).into());
        v.insert("theme".into(), name_of(self.theme, &THEMES).into());
        v.insert("glass_backdrop".into(), self.glass_backdrop.into());
        v.insert("glass_tint".into(), name_of(self.glass_tint, &TINTS).into());
        v.insert("open_on".into(), name_of(self.open_on, &OPENS).into());
        v.insert(
            "fold_delay".into(),
            name_of(self.fold_delay, &DELAYS).into(),
        );
        v.insert("motion".into(), self.motion.into());
        v.insert("hide_fullscreen".into(), self.hide_fullscreen.into());
        v.insert("alt_icons".into(), self.alt_icons.clone().into());
    }

    /** How much larger than normal the notch is drawn */
    pub fn scale(&self) -> f32 {
        match self.size {
            Size::Small => 0.85,
            Size::Normal => 1.0,
            Size::Large => 1.2,
        }
    }

    /** How long after the pointer left the card goes and the pill folds (ms) */
    pub fn graces(&self) -> (u32, u32) {
        match self.fold_delay {
            FoldDelay::Short => (120, 200),
            FoldDelay::Normal => (250, 450),
            FoldDelay::Long => (1_000, 1_500),
        }
    }
}

/** Where the window and the pill go along the edge, for a position (0 top … 100 bottom): the window's top in an area, and the
 * pill's top in the window. 50 centres both. A margin is kept at the ends so the flares stay inside */
pub fn along(position: u8, area: f32, win: f32, pill: f32) -> (f32, f32) {
    const MARGIN: f32 = 12.0;
    let f = f32::from(position.min(100)) / 100.0;
    let win_top = (area - win).max(0.0) * f;
    let pill_top = MARGIN + (win - pill - 2.0 * MARGIN).max(0.0) * f;
    // Too short for the margins: centred
    let pill_top = if win - pill < 2.0 * MARGIN {
        (win - pill) / 2.0
    } else {
        pill_top
    };
    (win_top, pill_top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn each_key_falls_back_on_its_own() {
        let p = Prefs::from_value(&json!({
            "url": "https://a.example", "display": 3, "position": 140, "size": "huge", "theme": "glass",
            "glass_backdrop": "yes", "glass_tint": "dark", "open_on": "click", "fold_delay": null, "motion": false
        }));
        assert_eq!(
            p,
            Prefs {
                theme: Theme::Glass,
                glass_tint: Tint::Dark,
                open_on: OpenOn::Click,
                motion: false,
                ..Prefs::default()
            }
        );
        assert_eq!(Prefs::from_value(&json!({ "position": 37.0 })).position, 37);
        assert_eq!(Prefs::from_value(&json!({ "position": 37.5 })).position, 50);
        assert_eq!(Prefs::from_value(&json!({ "position": -1 })).position, 50);
        assert_eq!(Prefs::from_value(&json!([1, 2])), Prefs::default());
        assert_eq!(Prefs::from_value(&json!({})), Prefs::default());
    }

    #[test]
    fn what_is_written_reads_back_the_same() {
        let p = Prefs {
            display: "\\\\.\\DISPLAY2".into(),
            position: 0,
            size: Size::Large,
            theme: Theme::Light,
            glass_backdrop: false,
            glass_tint: Tint::Light,
            open_on: OpenOn::Click,
            fold_delay: FoldDelay::Long,
            motion: false,
            hide_fullscreen: false,
            alt_icons: vec!["claude", "gemini"],
        };
        let mut m = Map::new();
        m.insert("url".into(), "https://a.example".into());
        p.write_into(&mut m);
        assert_eq!(m["size"], "large");
        assert_eq!(m["url"], "https://a.example", "the rest of the file stays");
        assert_eq!(Prefs::from_value(&Value::Object(m)), p);
    }

    #[test]
    fn the_second_icons_are_providers_once_each_in_order() {
        let alt = |v: Value| Prefs::from_value(&json!({ "alt_icons": v })).alt_icons;
        assert_eq!(
            alt(json!(["gemini", "claude", "x", 3, "claude"])),
            vec!["claude", "gemini"]
        );
        assert_eq!(alt(json!("claude")), Vec::<&str>::new());
        assert_eq!(alt(json!(null)), Vec::<&str>::new());
    }

    #[test]
    fn the_middle_is_centred_and_the_ends_keep_a_margin() {
        // A 1032-high area, the 660 window, a 300 pill
        assert_eq!(along(50, 1032.0, 660.0, 300.0), (186.0, 180.0));
        assert_eq!(along(0, 1032.0, 660.0, 300.0), (0.0, 12.0));
        assert_eq!(along(100, 1032.0, 660.0, 300.0), (372.0, 348.0));
        // A window as tall as the area: only the pill moves
        assert_eq!(along(100, 400.0, 400.0, 300.0).0, 0.0);
        // No room for the margins: centred
        assert_eq!(along(0, 300.0, 300.0, 290.0).1, 5.0);
    }
}
