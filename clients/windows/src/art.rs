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

/** Bytes that can be an icon: a PNG of 64 KB at most, whose header gives a size */
fn usable(png: &[u8]) -> bool {
    let size = |o: usize| u32::from_be_bytes([png[o], png[o + 1], png[o + 2], png[o + 3]]);
    png.len() <= MAX_ICON_BYTES
        && png.len() >= 24
        && png.starts_with(b"\x89PNG\r\n\x1a\n")
        && &png[12..16] == b"IHDR"
        && size(16) > 0
        && size(20) > 0
}

/** Whether the image decodes whole (its pixels can be read), as drawing needs: a header alone isn't enough */
fn decodes(png: &[u8]) -> bool {
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    let read = || -> windows::core::Result<bool> {
        unsafe {
            let wic: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = wic.CreateStream()?;
            stream.InitializeFromMemory(png)?;
            let decoder = wic.CreateDecoderFromStream(
                &stream,
                std::ptr::null(),
                WICDecodeMetadataCacheOnDemand,
            )?;
            let conv = wic.CreateFormatConverter()?;
            conv.Initialize(
                &decoder.GetFrame(0)?,
                &GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeMedianCut,
            )?;
            let (mut w, mut h) = (0u32, 0u32);
            conv.GetSize(&mut w, &mut h)?;
            if w == 0 || h == 0 || w > 4096 || h > 4096 {
                return Ok(false);
            }
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            conv.CopyPixels(std::ptr::null(), w * 4, &mut pixels)?;
            Ok(true)
        }
    };
    read().unwrap_or(false)
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

/** A provider's icon of the first or the second set (the user's folder first, then the build), when there is one that decodes */
pub fn png(provider: &str, alt: bool) -> Option<Vec<u8>> {
    let file = folder().map(|d| {
        let d = if alt { d.join("alt") } else { d };
        d.join(format!("{provider}.png"))
    });
    // Read only when small enough (a large file isn't read whole)
    let from_folder = file
        .filter(|f| std::fs::metadata(f).is_ok_and(|m| m.len() as usize <= MAX_ICON_BYTES))
        .and_then(|f| std::fs::read(f).ok())
        .filter(|b| usable(b) && decodes(b));
    from_folder.or_else(|| {
        built(provider, alt)
            .filter(|b| usable(b) && decodes(b))
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
    fn only_an_image_that_decodes_whole_is_taken() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            );
        }
        // A 1×1 PNG
        let one: [u8; 68] = [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 96, 0,
            0, 0, 6, 0, 2, 48, 129, 208, 47, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ];
        assert!(usable(&one) && decodes(&one));
        // Its header alone (no image data): not taken
        assert!(usable(&one[..33]) && !decodes(&one[..33]));
    }

    #[test]
    fn only_small_pngs_with_a_size_are_icons() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16]);
        assert!(usable(&png));
        assert!(!usable(b"\x89PNG\r\n\x1a\n"), "no header");
        let mut empty = png.clone();
        empty[19] = 0;
        assert!(!usable(&empty), "no width");
        assert!(!usable(b"GIF89a"));
        let mut big = png.clone();
        big.resize(MAX_ICON_BYTES + 1, 0);
        assert!(!usable(&big));
    }
}
