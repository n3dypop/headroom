//! Drawing: Direct2D into a DC render target (bound to the layered window's bitmap), DirectWrite for text, WIC for the icons.

use windows::core::{w, Result};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::HDC;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows_numerics::Vector2;

pub fn pt(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}

pub fn rect(left: f32, top: f32, right: f32, bottom: f32) -> D2D_RECT_F {
    D2D_RECT_F {
        left,
        top,
        right,
        bottom,
    }
}

/** "#rrggbb" with an alpha */
pub fn color(hex: &str, a: f32) -> D2D1_COLOR_F {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    D2D1_COLOR_F {
        r: ((v >> 16) & 255) as f32 / 255.0,
        g: ((v >> 8) & 255) as f32 / 255.0,
        b: (v & 255) as f32 / 255.0,
        a,
    }
}

/** Where a text goes: its box, alignment, color and whether its digits keep one width (countdowns don't jitter) */
pub struct Place {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub align: DWRITE_TEXT_ALIGNMENT,
    pub hex: &'static str,
    pub alpha: f32,
    pub tabular: bool,
}

impl Place {
    pub fn at(x: f32, y: f32, w: f32, h: f32) -> Place {
        Place {
            x,
            y,
            w,
            h,
            align: DWRITE_TEXT_ALIGNMENT_LEADING,
            hex: "#ffffff",
            alpha: 1.0,
            tabular: false,
        }
    }
    pub fn align(mut self, align: DWRITE_TEXT_ALIGNMENT) -> Place {
        self.align = align;
        self
    }
    pub fn color(mut self, hex: &'static str, alpha: f32) -> Place {
        self.hex = hex;
        self.alpha = alpha;
        self
    }
    pub fn tabular(mut self) -> Place {
        self.tabular = true;
        self
    }
}

pub struct Gfx {
    pub d2d: ID2D1Factory,
    pub dw: IDWriteFactory,
    wic: IWICImagingFactory,
    pub rt: ID2D1DCRenderTarget,
    tabular: IDWriteTypography,
}

fn target(d2d: &ID2D1Factory, dpi: f32) -> Result<ID2D1DCRenderTarget> {
    let props = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
        },
        dpiX: dpi,
        dpiY: dpi,
        usage: D2D1_RENDER_TARGET_USAGE_NONE,
        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
    };
    unsafe { d2d.CreateDCRenderTarget(&props) }
}

impl Gfx {
    pub fn new(dpi: f32) -> Result<Gfx> {
        unsafe {
            let d2d: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let dw: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            let wic: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let rt = target(&d2d, dpi)?;
            let tabular = dw.CreateTypography()?;
            tabular.AddFontFeature(DWRITE_FONT_FEATURE {
                nameTag: DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES,
                parameter: 1,
            })?;
            Ok(Gfx {
                d2d,
                dw,
                wic,
                rt,
                tabular,
            })
        }
    }

    /** A new render target (after the old one was lost); bitmaps made on the old one must be made again */
    pub fn renew(&mut self, dpi: f32) -> Result<()> {
        self.rt = target(&self.d2d, dpi)?;
        Ok(())
    }

    pub fn bind(&self, dc: HDC, w: i32, h: i32, dpi: f32) -> Result<()> {
        unsafe {
            self.rt.SetDpi(dpi, dpi);
            self.rt.BindDC(
                dc,
                &RECT {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                },
            )
        }
    }

    pub fn brush(&self, hex: &str, a: f32) -> Result<ID2D1SolidColorBrush> {
        unsafe { self.rt.CreateSolidColorBrush(&color(hex, a), None) }
    }

    pub fn format(
        &self,
        family: &str,
        size: f32,
        weight: DWRITE_FONT_WEIGHT,
    ) -> Result<IDWriteTextFormat> {
        let family: Vec<u16> = family.encode_utf16().chain([0]).collect();
        unsafe {
            let f = self.dw.CreateTextFormat(
                windows::core::PCWSTR(family.as_ptr()),
                None,
                weight,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                w!("en-us"),
            )?;
            f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
            Ok(f)
        }
    }

    /** A laid-out line of text, cut with "…" when it doesn't fit its box */
    pub fn layout(&self, s: &str, f: &IDWriteTextFormat, p: &Place) -> Result<IDWriteTextLayout> {
        let text: Vec<u16> = s.encode_utf16().collect();
        unsafe {
            let layout = self.dw.CreateTextLayout(&text, f, p.w.max(0.0), p.h)?;
            layout.SetTextAlignment(p.align)?;
            let sign = self.dw.CreateEllipsisTrimmingSign(f)?;
            let trimming = DWRITE_TRIMMING {
                granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                delimiter: 0,
                delimiterCount: 0,
            };
            layout.SetTrimming(&trimming, &sign)?;
            if p.tabular {
                layout.SetTypography(
                    &self.tabular,
                    DWRITE_TEXT_RANGE {
                        startPosition: 0,
                        length: text.len() as u32,
                    },
                )?;
            }
            Ok(layout)
        }
    }

    /** Width of a text as it would be drawn */
    pub fn width(&self, s: &str, f: &IDWriteTextFormat, tabular: bool) -> Result<f32> {
        let mut p = Place::at(0.0, 0.0, 10_000.0, 100.0);
        p.tabular = tabular;
        let layout = self.layout(s, f, &p)?;
        let mut m = DWRITE_TEXT_METRICS::default();
        unsafe { layout.GetMetrics(&mut m)? };
        Ok(m.widthIncludingTrailingWhitespace)
    }

    /** Draws a text in its box; returns its width */
    pub fn text(&self, s: &str, f: &IDWriteTextFormat, p: Place) -> Result<f32> {
        let layout = self.layout(s, f, &p)?;
        unsafe {
            let mut m = DWRITE_TEXT_METRICS::default();
            layout.GetMetrics(&mut m)?;
            self.rt.DrawTextLayout(
                pt(p.x, p.y),
                &layout,
                &self.brush(p.hex, p.alpha)?,
                D2D1_DRAW_TEXT_OPTIONS_NONE,
            );
            Ok(m.width)
        }
    }

    /** An arc of a ring from `from` to `to` (fractions of the circle, clockwise from 12 o'clock), with flat ends */
    #[allow(clippy::too_many_arguments)]
    pub fn arc(
        &self,
        cx: f32,
        cy: f32,
        r: f32,
        from: f32,
        to: f32,
        width: f32,
        hex: &str,
        a: f32,
    ) -> Result<()> {
        if to - from <= 0.0005 {
            return Ok(());
        }
        unsafe {
            let brush = self.brush(hex, a)?;
            if to - from >= 0.9995 {
                self.rt.DrawEllipse(
                    &D2D1_ELLIPSE {
                        point: pt(cx, cy),
                        radiusX: r,
                        radiusY: r,
                    },
                    &brush,
                    width,
                    None,
                );
                return Ok(());
            }
            let at = |f: f32| {
                let t = f * std::f32::consts::TAU;
                pt(cx + r * t.sin(), cy - r * t.cos())
            };
            let g = self.d2d.CreatePathGeometry()?;
            let sink = g.Open()?;
            sink.BeginFigure(at(from), D2D1_FIGURE_BEGIN_HOLLOW);
            sink.AddArc(&D2D1_ARC_SEGMENT {
                point: at(to),
                size: D2D_SIZE_F {
                    width: r,
                    height: r,
                },
                rotationAngle: 0.0,
                sweepDirection: D2D1_SWEEP_DIRECTION_CLOCKWISE,
                arcSize: if to - from > 0.5 {
                    D2D1_ARC_SIZE_LARGE
                } else {
                    D2D1_ARC_SIZE_SMALL
                },
            });
            sink.EndFigure(D2D1_FIGURE_END_OPEN);
            sink.Close()?;
            self.rt.DrawGeometry(&g, &brush, width, None);
        }
        Ok(())
    }

    pub fn rounded(&self, r: D2D_RECT_F, radius: f32) -> Result<ID2D1RoundedRectangleGeometry> {
        unsafe {
            self.d2d.CreateRoundedRectangleGeometry(&D2D1_ROUNDED_RECT {
                rect: r,
                radiusX: radius,
                radiusY: radius,
            })
        }
    }

    /** Everything drawn until pop_layer is cut to the shape */
    pub fn push_mask(&self, shape: &ID2D1Geometry) {
        let params = D2D1_LAYER_PARAMETERS {
            contentBounds: rect(-1e6, -1e6, 1e6, 1e6),
            geometricMask: std::mem::ManuallyDrop::new(Some(shape.clone())),
            maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
            maskTransform: windows_numerics::Matrix3x2::identity(),
            opacity: 1.0,
            opacityBrush: std::mem::ManuallyDrop::new(None),
            layerOptions: D2D1_LAYER_OPTIONS_NONE,
        };
        unsafe { self.rt.PushLayer(&params, None) };
        // The parameters hold their own reference to the shape; the render target took its own
        let _ = std::mem::ManuallyDrop::into_inner(params.geometricMask);
    }

    pub fn pop_layer(&self) {
        unsafe { self.rt.PopLayer() };
    }

    /** A PNG as a bitmap of this render target */
    pub fn png(&self, bytes: &[u8]) -> Result<ID2D1Bitmap> {
        unsafe {
            let stream = self.wic.CreateStream()?;
            stream.InitializeFromMemory(bytes)?;
            let decoder = self.wic.CreateDecoderFromStream(
                &stream,
                std::ptr::null(),
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = decoder.GetFrame(0)?;
            let conv = self.wic.CreateFormatConverter()?;
            conv.Initialize(
                &frame,
                &GUID_WICPixelFormat32bppPBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeMedianCut,
            )?;
            self.rt.CreateBitmapFromWicBitmap(&conv, None)
        }
    }
}
