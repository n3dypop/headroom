//! The provider icons: two sets, as on the widget (the second chosen per provider in Settings). Each is read from the user's
//! folder (%APPDATA%\Headroom\icons\ and icons\alt\) when there, else taken from the build (packages/scriptable/icons/, when
//! that had them). They are the vendors' logos, so neither the repository nor the release packages have them.

use std::path::PathBuf;

/** The widget's build takes icons of 64 KB at most */
const MAX_ICON_BYTES: usize = 64 * 1024;

/** The user's icon folder: %APPDATA%\Headroom\icons (the second set in its alt folder) */
pub fn folder() -> Option<PathBuf> {
    crate::server::settings_path().and_then(|p| p.parent().map(|d| d.join("icons")))
}

/** Bytes that can be an icon: a PNG of 64 KB at most */
fn usable(png: &[u8]) -> bool {
    png.len() <= MAX_ICON_BYTES && png.starts_with(b"\x89PNG")
}

fn built(provider: &str, alt: bool) -> Option<&'static [u8]> {
    match (provider, alt) {
        ("claude", false) => crate::icons::CLAUDE,
        ("codex", false) => crate::icons::CODEX,
        ("gemini", false) => crate::icons::GEMINI,
        ("claude", true) => crate::icons::CLAUDE_ALT,
        ("codex", true) => crate::icons::CODEX_ALT,
        ("gemini", true) => crate::icons::GEMINI_ALT,
        _ => None,
    }
}

/** A provider's icon of the first or the second set (the user's folder first), when there is one */
pub fn png(provider: &str, alt: bool) -> Option<Vec<u8>> {
    let file = folder().map(|d| {
        let d = if alt { d.join("alt") } else { d };
        d.join(format!("{provider}.png"))
    });
    // Read only when small enough (a large file isn't read whole)
    let from_folder = file
        .filter(|f| std::fs::metadata(f).is_ok_and(|m| m.len() as usize <= MAX_ICON_BYTES))
        .and_then(|f| std::fs::read(f).ok())
        .filter(|b| usable(b));
    from_folder.or_else(|| {
        built(provider, alt)
            .filter(|b| usable(b))
            .map(<[u8]>::to_vec)
    })
}

/** Whether a provider has a second icon to switch to */
pub fn has_alt(provider: &str) -> bool {
    png(provider, true).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_small_pngs_are_icons() {
        assert!(usable(b"\x89PNG\r\n\x1a\n"));
        assert!(!usable(b"GIF89a"));
        let mut big = b"\x89PNG".to_vec();
        big.resize(MAX_ICON_BYTES + 1, 0);
        assert!(!usable(&big));
    }
}
