//! Liquid glass, after liquidGL (MIT, github.com/naughtyduk/liquidGL): what is behind a shape, blurred, with the band along its
//! edge magnified a little (light bent by the glass's bevel), under a thin film of the tint, a rim of light brighter at the top,
//! and a soft highlight. What is behind is read from the screen only while the notch is open, kept in memory and never saved or
//! sent; the notch is left out of screen copies meanwhile (notch.rs), so it never reads itself. Without it the film is denser
//! and the rest the same.

use crate::gfx::{color, pt, Gfx};
use crate::theme::Ink;
use windows::core::{Interface, Result};
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::*;
use windows_numerics::Matrix3x2;

/** How much what is behind is blurred (DIPs), and how much the band along the edge is magnified */
const FROST: f32 = 7.0;
const BEND: f32 = 1.08;

/** A copy of the screen under a rectangle (physical pixels, BGRA rows top-down); None when it can't be read */
pub fn capture(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
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
        let mut out = None;
        if let Ok(bitmap) = CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            let old = SelectObject(mem, bitmap.into());
            // GDI may batch the copy: flushed before the pixels are read
            if BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok()
                && GdiFlush().as_bool()
                && !bits.is_null()
            {
                let n = (w * h * 4) as usize;
                out = Some(std::slice::from_raw_parts(bits as *const u8, n).to_vec());
            }
            SelectObject(mem, old);
            let _ = DeleteObject(bitmap.into());
        }
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        out
    }
}

/** The glass's drawing state, made on the render target (made again with it) */
#[derive(Default)]
pub struct Glass {
    /// What effects need (None when the render target can't give it: the glass then only looks like glass)
    dc: Option<ID2D1DeviceContext>,
    blur: Option<ID2D1Effect>,
    /// What is behind the window, at its size
    backdrop: Option<ID2D1Bitmap>,
    /// The render target can't give the effects: nothing is read, the glass only looks like glass
    unsupported: bool,
    /// When what is behind was last read (never more often than MIN_READ)
    read_at: Option<std::time::Instant>,
}

/** What is behind is read at most this often, whatever asks for it */
pub const MIN_READ: std::time::Duration = std::time::Duration::from_millis(250);

impl Glass {
    /** The render target was made again: what was made on the old one goes (when the screen was last read stays, so the
     * reads keep their interval) */
    pub fn reset(&mut self) {
        *self = Glass {
            read_at: self.read_at,
            ..Glass::default()
        };
    }

    pub fn drop_backdrop(&mut self) {
        self.backdrop = None;
        if let Some(b) = &self.blur {
            unsafe { b.SetInput(0, None::<&ID2D1Image>, true) };
        }
    }

    /** Whether what is behind is there to be drawn */
    pub fn has_backdrop(&self) -> bool {
        self.backdrop.is_some() && self.blur.is_some()
    }

    /** Whether what is behind may be read now: the effects to draw it are there (made now when they aren't yet), and the last
     * read was at least MIN_READ ago. A yes counts as a read */
    pub fn may_read(&mut self, g: &Gfx) -> bool {
        if self.unsupported || self.read_at.is_some_and(|at| at.elapsed() < MIN_READ) {
            return false;
        }
        if self.prepare(g).is_err() {
            self.unsupported = true;
            self.dc = None;
            self.blur = None;
            return false;
        }
        self.read_at = Some(std::time::Instant::now());
        true
    }

    /** Makes the effects on the render target */
    fn prepare(&mut self, g: &Gfx) -> Result<()> {
        unsafe {
            if self.dc.is_none() {
                self.dc = Some(g.rt.cast::<ID2D1DeviceContext>()?);
            }
            let dc = self.dc.as_ref().expect("set");
            if self.blur.is_none() {
                let blur = dc.CreateEffect(&CLSID_D2D1GaussianBlur)?;
                blur.SetValue(
                    D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION.0 as u32,
                    D2D1_PROPERTY_TYPE_FLOAT,
                    &FROST.to_le_bytes(),
                )?;
                // Hard edges: the blur doesn't fade to clear at the window's sides
                blur.SetValue(
                    D2D1_GAUSSIANBLUR_PROP_BORDER_MODE.0 as u32,
                    D2D1_PROPERTY_TYPE_ENUM,
                    &(D2D1_BORDER_MODE_HARD.0 as u32).to_le_bytes(),
                )?;
                self.blur = Some(blur);
            }
        }
        Ok(())
    }

    /** Takes a new copy of what is behind the window (pixels at the window's size, drawn at the window's DPI) */
    pub fn set_backdrop(&mut self, g: &Gfx, pixels: &[u8], w: i32, h: i32, dpi: f32) -> Result<()> {
        self.prepare(g)?;
        unsafe {
            let props = D2D1_BITMAP_PROPERTIES {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: dpi,
                dpiY: dpi,
            };
            let bitmap = g.rt.CreateBitmap(
                D2D_SIZE_U {
                    width: w as u32,
                    height: h as u32,
                },
                Some(pixels.as_ptr().cast()),
                (w * 4) as u32,
                &props,
            )?;
            let image: ID2D1Image = bitmap.cast()?;
            self.blur
                .as_ref()
                .expect("set")
                .SetInput(0, Some(&image), true);
            self.backdrop = Some(bitmap);
        }
        Ok(())
    }

    /** Draws a shape as glass. `inner` is the shape less its bevel (the band between them bends what is behind); `bounds` its
     * box; `film` the tint over it; `alpha` how much of it shows (as it opens) */
    pub fn fill(
        &self,
        g: &Gfx,
        shape: &ID2D1Geometry,
        inner: Option<&ID2D1Geometry>,
        bounds: D2D_RECT_F,
        film: Ink,
        alpha: f32,
    ) -> Result<()> {
        if alpha <= 0.0 {
            return Ok(());
        }
        unsafe {
            // A soft shadow around it, lifting it off what is behind
            for (w, a) in [(9.0, 0.035), (5.0, 0.05), (2.5, 0.07)] {
                g.rt.DrawGeometry(shape, &g.brush("#000000", a * alpha)?, w, None);
            }
            if let (Some(dc), Some(blur), true) = (&self.dc, &self.blur, self.backdrop.is_some()) {
                let out = blur.GetOutput()?;
                g.push_mask(shape);
                dc.DrawImage(
                    &out,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                );
                g.pop_layer();
                if let Some(inner) = inner {
                    // The band along the edge: magnified about the shape's centre, as a bevel bends light
                    let band = g.d2d.CreatePathGeometry()?;
                    let sink = band.Open()?;
                    shape.CombineWithGeometry(
                        inner,
                        D2D1_COMBINE_MODE_EXCLUDE,
                        None,
                        0.25,
                        &sink,
                    )?;
                    sink.Close()?;
                    let band: ID2D1Geometry = band.cast()?;
                    let (cx, cy) = (
                        (bounds.left + bounds.right) / 2.0,
                        (bounds.top + bounds.bottom) / 2.0,
                    );
                    let mut before = Matrix3x2::default();
                    g.rt.GetTransform(&mut before);
                    g.push_mask(&band);
                    g.rt.SetTransform(&(scale_about(BEND, cx, cy) * before));
                    dc.DrawImage(
                        &out,
                        None,
                        None,
                        D2D1_INTERPOLATION_MODE_LINEAR,
                        D2D1_COMPOSITE_MODE_SOURCE_OVER,
                    );
                    g.rt.SetTransform(&before);
                    g.pop_layer();
                }
            }
            // The film of the tint
            g.rt.FillGeometry(shape, &g.brush(film.0, film.1 * alpha)?, None);
            // The rim of light: brightest at the top, a little at the bottom
            let rim = gradient(
                g,
                &[(0.0, 0.62), (0.18, 0.16), (0.7, 0.06), (1.0, 0.30)],
                alpha,
            )?;
            let line = g.rt.CreateLinearGradientBrush(
                &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                    startPoint: pt(bounds.left, bounds.top),
                    endPoint: pt(bounds.left, bounds.bottom),
                },
                None,
                &rim,
            )?;
            g.rt.DrawGeometry(shape, &line, 1.2, None);
            // A soft highlight in the upper part
            let w = bounds.right - bounds.left;
            let h = bounds.bottom - bounds.top;
            let glow = gradient(g, &[(0.0, 0.20), (1.0, 0.0)], alpha)?;
            let spot = g.rt.CreateRadialGradientBrush(
                &D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES {
                    center: pt(bounds.left + w * 0.35, bounds.top + (h * 0.1).min(30.0)),
                    gradientOriginOffset: pt(0.0, 0.0),
                    radiusX: w * 0.75,
                    radiusY: (h * 0.35).min(110.0),
                },
                None,
                &glow,
            )?;
            g.push_mask(shape);
            g.rt.FillRectangle(&bounds, &spot);
            g.pop_layer();
        }
        Ok(())
    }
}

/** White stops at offsets with opacities (times `alpha`) */
fn gradient(g: &Gfx, stops: &[(f32, f32)], alpha: f32) -> Result<ID2D1GradientStopCollection> {
    let stops: Vec<D2D1_GRADIENT_STOP> = stops
        .iter()
        .map(|&(position, a)| D2D1_GRADIENT_STOP {
            position,
            color: color("#ffffff", a * alpha),
        })
        .collect();
    unsafe {
        g.rt.CreateGradientStopCollection(&stops, D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP)
    }
}

/** A scale about a point */
fn scale_about(s: f32, cx: f32, cy: f32) -> Matrix3x2 {
    Matrix3x2 {
        M11: s,
        M12: 0.0,
        M21: 0.0,
        M22: s,
        M31: cx * (1.0 - s),
        M32: cy * (1.0 - s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bend_keeps_the_centre_where_it_is() {
        let m = scale_about(1.08, 100.0, 50.0);
        let at = |x: f32, y: f32| (x * m.M11 + y * m.M21 + m.M31, x * m.M12 + y * m.M22 + m.M32);
        assert_eq!(at(100.0, 50.0), (100.0, 50.0));
        let (x, _) = at(110.0, 50.0);
        assert!((x - 110.8).abs() < 1e-4);
    }
}
