//! Renders known 64x64 images through the "restorff-grade" shader on a headless host GPU
//! (DX12 / Vulkan / Metal via wgpu, same WGSL as the browser) and checks the pixels: identity
//! at defaults, each control against its anchor points, and a full look against a CPU
//! reference of the same maths. Without a GPU adapter each test prints "skipping" and passes;
//! run with `--nocapture` to see which adapter was used. The harness is a copy of
//! `gpu_render.rs` (test binaries cannot share modules without a helper crate).

use std::collections::HashMap;

use effects::{ApplyEffectsOptions, EffectPass, EffectPipeline, GRADE_SHADER_ID, UniformValue};
use gpu::{GpuContext, wgpu};

const SIZE: u32 = 64;

struct Harness {
    context: GpuContext,
    pipeline: EffectPipeline,
}

fn harness() -> Option<Harness> {
    match pollster::block_on(GpuContext::new()) {
        Ok(context) => {
            let info = context.adapter().get_info();
            eprintln!("GPU grade test on {} ({:?})", info.name, info.backend);
            let pipeline = EffectPipeline::new(&context);
            Some(Harness { context, pipeline })
        }
        Err(error) => {
            eprintln!("skipping GPU render test: {error}");
            None
        }
    }
}

type Image = Vec<[u8; 4]>;

fn image(pixel: impl Fn(u32, u32) -> [u8; 4]) -> Image {
    (0..SIZE * SIZE).map(|index| pixel(index % SIZE, index / SIZE)).collect()
}

fn at(image: &Image, x: u32, y: u32) -> [u8; 4] {
    image[(y * SIZE + x) as usize]
}

fn is_bgra(harness: &Harness) -> bool {
    harness.context.texture_format() == wgpu::TextureFormat::Bgra8Unorm
}

fn upload(harness: &Harness, pixels: &Image) -> wgpu::Texture {
    let texture = harness.context.create_render_texture(SIZE, SIZE, "grade-test-input");
    let swap = is_bgra(harness);
    let bytes: Vec<u8> = pixels
        .iter()
        .flat_map(|[r, g, b, a]| if swap { [*b, *g, *r, *a] } else { [*r, *g, *b, *a] })
        .collect();
    harness.context.queue().write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(SIZE * 4),
            rows_per_image: Some(SIZE),
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn read_back(harness: &Harness, texture: &wgpu::Texture) -> Image {
    let device = harness.context.device();
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("grade-test-readback"),
        size: u64::from(SIZE * SIZE * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("grade-test-readback-encoder"),
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SIZE * 4),
                rows_per_image: Some(SIZE),
            },
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    harness.context.queue().submit([encoder.finish()]);
    buffer.map_async(wgpu::MapMode::Read, .., |result| result.expect("map readback buffer"));
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("poll device");
    let swap = is_bgra(harness);
    let pixels = buffer
        .get_mapped_range(..)
        .chunks_exact(4)
        .map(|p| if swap { [p[2], p[1], p[0], p[3]] } else { [p[0], p[1], p[2], p[3]] })
        .collect();
    buffer.unmap();
    pixels
}

fn grade(harness: &Harness, input: &Image, uniforms: &[(&str, UniformValue)]) -> Image {
    let source = upload(harness, input);
    let pass = EffectPass {
        shader: GRADE_SHADER_ID.to_string(),
        uniforms: uniforms
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect::<HashMap<_, _>>(),
    };
    let output = harness
        .pipeline
        .apply(
            &harness.context,
            ApplyEffectsOptions {
                source: &source,
                width: SIZE,
                height: SIZE,
                passes: &[pass],
            },
        )
        .expect("grade applies");
    read_back(harness, &output)
}

fn number(value: f32) -> UniformValue {
    UniformValue::Number(value)
}

fn vector(values: &[f32]) -> UniformValue {
    UniformValue::Vector(values.to_vec())
}

fn flat(rgba: [u8; 4]) -> Image {
    image(|_, _| rgba)
}

/// A colourful test card: R ramps with x, G with y, B with x + y, alpha opaque.
fn colour_card() -> Image {
    image(|x, y| [(x * 4) as u8, (y * 4) as u8, ((x + y) * 2) as u8, 255])
}

fn assert_close(actual: [u8; 4], expected: [u8; 4], tolerance: u8, what: &str) {
    for channel in 0..4 {
        let difference = actual[channel].abs_diff(expected[channel]);
        assert!(difference <= tolerance, "{what}: got {actual:?}, expected {expected:?} (+/-{tolerance})");
    }
}

fn assert_images_close(actual: &Image, expected: &Image, tolerance: u8, what: &str) {
    for y in 0..SIZE {
        for x in 0..SIZE {
            assert_close(at(actual, x, y), at(expected, x, y), tolerance, &format!("{what} at ({x}, {y})"));
        }
    }
}

// ---------------------------------------------------------------- CPU reference of grade.wgsl

#[derive(Clone, Copy)]
struct Look {
    exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    tint: f32,
    lift: f32,
    gamma: f32,
    gain: f32,
    vignette: f32,
    amount: f32,
    split: [f32; 4],
}

impl Look {
    fn uniforms(&self) -> Vec<(&'static str, UniformValue)> {
        vec![
            ("u_exposure", number(self.exposure)),
            ("u_contrast", number(self.contrast)),
            ("u_saturation", number(self.saturation)),
            ("u_temperature", number(self.temperature)),
            ("u_tint", number(self.tint)),
            ("u_lift", number(self.lift)),
            ("u_gamma", number(self.gamma)),
            ("u_gain", number(self.gain)),
            ("u_vignette", number(self.vignette)),
            ("u_amount", number(self.amount)),
            ("u_split", vector(&self.split)),
        ]
    }
}

const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(c: f32) -> f32 {
    let x = c.clamp(0.0, 1.0);
    if x <= 0.0031308 { x * 12.92 } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
}

fn hue_rgb(hue: f32) -> [f32; 3] {
    let h = hue - hue.floor();
    let channel = |offset: f32| {
        let v = h + offset;
        let f = v - v.floor();
        ((f * 6.0 - 3.0).abs() - 1.0).clamp(0.0, 1.0)
    };
    [channel(0.0), channel(2.0 / 3.0), channel(1.0 / 3.0)]
}

/// The shader's maths on one pixel (grain 0). `uv` = the pixel centre in 0..1.
fn reference(look: &Look, pixel: [u8; 4], uv: [f32; 2]) -> [u8; 4] {
    let source = [pixel[0] as f32 / 255.0, pixel[1] as f32 / 255.0, pixel[2] as f32 / 255.0];
    let t = look.temperature.clamp(-1.0, 1.0);
    let g = look.tint.clamp(-1.0, 1.0);
    let mut balance = [1.0 + 0.3 * t, 1.0 - 0.25 * g, 1.0 - 0.3 * t];
    let norm = dot3(balance, LUMA);
    for b in &mut balance {
        *b /= norm;
    }
    let scale = look.exposure.exp2();
    let mut c = [0.0f32; 3];
    for i in 0..3 {
        c[i] = linear_to_srgb(srgb_to_linear(source[i]) * balance[i] * scale);
    }
    let lift = look.lift.clamp(-0.5, 0.5);
    let gamma = look.gamma.max(0.05);
    for v in &mut c {
        *v = look.gain.max(0.0) * (*v + lift * (1.0 - *v));
        *v = v.max(0.0).powf(1.0 / gamma).clamp(0.0, 1.0);
    }
    let k = (look.contrast.clamp(-1.0, 1.0) * 1.5).exp2();
    for v in &mut c {
        let rising = v.powf(k);
        let falling = (1.0 - *v).powf(k);
        *v = rising / (rising + falling).max(0.000001);
    }
    let luma = dot3(c, LUMA);
    for v in &mut c {
        *v = luma + (*v - luma) * look.saturation.max(0.0);
    }
    let shadow = hue_rgb(look.split[0]);
    let highlight = hue_rgb(look.split[2]);
    let shadow_luma = dot3(shadow, LUMA);
    let highlight_luma = dot3(highlight, LUMA);
    let shadow_weight = 1.0 - smoothstep(0.0, 0.6, luma);
    let highlight_weight = smoothstep(0.4, 1.0, luma);
    for i in 0..3 {
        c[i] += (shadow[i] - shadow_luma) * look.split[1].clamp(0.0, 1.0) * shadow_weight * 0.3
            + (highlight[i] - highlight_luma) * look.split[3].clamp(0.0, 1.0) * highlight_weight * 0.3;
        c[i] = c[i].clamp(0.0, 1.0);
    }
    let dx = (uv[0] - 0.5) * 2.0;
    let dy = (uv[1] - 0.5) * 2.0;
    let edge = (dx * dx + dy * dy).sqrt() * 0.70710678;
    let falloff = smoothstep(0.35, 1.0, edge);
    let vignette = look.vignette.clamp(-1.0, 1.0);
    let darken = vignette.max(0.0) * falloff * 0.85;
    let lighten = (-vignette).max(0.0) * falloff * 0.5;
    let amount = look.amount.clamp(0.0, 1.0);
    let mut out = [0u8; 4];
    for i in 0..3 {
        let mut v = c[i] * (1.0 - darken);
        v += (1.0 - v) * lighten;
        let mixed = source[i] + (v.clamp(0.0, 1.0) - source[i]) * amount;
        out[i] = (mixed * 255.0).round() as u8;
    }
    out[3] = pixel[3];
    out
}

fn uv_of(x: u32, y: u32) -> [f32; 2] {
    [(x as f32 + 0.5) / SIZE as f32, (y as f32 + 0.5) / SIZE as f32]
}

// ---------------------------------------------------------------- tests

#[test]
fn grade_defaults_leave_the_frame_untouched() {
    let Some(harness) = harness() else { return };
    let card = colour_card();
    assert_images_close(&grade(&harness, &card, &[]), &card, 1, "no uniforms");
    // A seed alone draws no grain.
    assert_images_close(&grade(&harness, &card, &[("u_grain_seed", number(7.25))]), &card, 1, "seed, grain 0");
}

#[test]
fn grade_exposure_moves_mid_grey_by_stops() {
    let Some(harness) = harness() else { return };
    let grey = flat([128, 128, 128, 255]);
    let neutral = Look {
        exposure: 0.0,
        contrast: 0.0,
        saturation: 1.0,
        temperature: 0.0,
        tint: 0.0,
        lift: 0.0,
        gamma: 1.0,
        gain: 1.0,
        vignette: 0.0,
        amount: 1.0,
        split: [0.0; 4],
    };
    for stops in [1.0f32, -1.0] {
        let output = grade(&harness, &grey, &[("u_exposure", number(stops))]);
        let expected = reference(&Look { exposure: stops, ..neutral }, [128, 128, 128, 255], uv_of(32, 32));
        assert_close(at(&output, 32, 32), expected, 1, &format!("exposure {stops}"));
    }
    // +1 stop on sRGB 128 = 2x linear light: ~176; -1 stop: ~92.
    let up = at(&grade(&harness, &grey, &[("u_exposure", number(1.0))]), 10, 10)[0];
    let down = at(&grade(&harness, &grey, &[("u_exposure", number(-1.0))]), 10, 10)[0];
    assert!((174..=178).contains(&up), "+1 stop: {up}");
    assert!((90..=94).contains(&down), "-1 stop: {down}");
}

#[test]
fn grade_saturation_zero_is_rec709_grey() {
    let Some(harness) = harness() else { return };
    let orange = flat([200, 100, 50, 255]);
    let output = grade(&harness, &orange, &[("u_saturation", number(0.0))]);
    // 0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50 = 117.65
    assert_close(at(&output, 32, 32), [118, 118, 118, 255], 1, "saturation 0");
    let boosted = at(&grade(&harness, &orange, &[("u_saturation", number(1.5))]), 32, 32);
    assert!(boosted[0] > 200 && boosted[2] < 50, "saturation 1.5 pushes channels apart: {boosted:?}");
}

#[test]
fn grade_temperature_warms_and_tint_goes_magenta() {
    let Some(harness) = harness() else { return };
    let grey = flat([128, 128, 128, 255]);
    let [r, g, b, _] = at(&grade(&harness, &grey, &[("u_temperature", number(1.0))]), 32, 32);
    assert!(r > g + 10 && g > b + 10, "warm: red up, blue down, got {r} {g} {b}");
    let [r, g, b, _] = at(&grade(&harness, &grey, &[("u_temperature", number(-1.0))]), 32, 32);
    assert!(b > g + 10 && g > r + 10, "cool: blue up, red down, got {r} {g} {b}");
    let [r, g, b, _] = at(&grade(&harness, &grey, &[("u_tint", number(1.0))]), 32, 32);
    assert!(r > g + 10 && b > g + 10, "tint +1 is magenta, got {r} {g} {b}");
    // White balance moves colour, not brightness: linear luminance is kept.
    let [r, g, b, _] = at(&grade(&harness, &grey, &[("u_temperature", number(0.6)), ("u_tint", number(-0.4))]), 32, 32);
    let luminance = dot3(
        [srgb_to_linear(r as f32 / 255.0), srgb_to_linear(g as f32 / 255.0), srgb_to_linear(b as f32 / 255.0)],
        LUMA,
    );
    let original = srgb_to_linear(128.0 / 255.0);
    assert!((luminance - original).abs() < 0.01, "luminance {luminance} vs {original}");
}

#[test]
fn grade_lift_gamma_gain_hit_their_anchor_points() {
    let Some(harness) = harness() else { return };
    let black = flat([0, 0, 0, 255]);
    let white = flat([255, 255, 255, 255]);
    // lift 0.1: black -> 0.1 (25.5), white stays white
    assert_close(at(&grade(&harness, &black, &[("u_lift", number(0.1))]), 32, 32), [26, 26, 26, 255], 1, "lift black");
    assert_close(at(&grade(&harness, &white, &[("u_lift", number(0.1))]), 32, 32), [255, 255, 255, 255], 1, "lift white");
    // gain 0.5: white -> 127.5, black stays black
    assert_close(at(&grade(&harness, &white, &[("u_gain", number(0.5))]), 32, 32), [128, 128, 128, 255], 1, "gain white");
    assert_close(at(&grade(&harness, &black, &[("u_gain", number(0.5))]), 32, 32), [0, 0, 0, 255], 0, "gain black");
    // gamma 2: 64/255 = 0.251 -> sqrt = 0.501 (127.7); ends fixed
    let quarter = flat([64, 64, 64, 255]);
    assert_close(at(&grade(&harness, &quarter, &[("u_gamma", number(2.0))]), 32, 32), [128, 128, 128, 255], 1, "gamma 2");
    assert_close(at(&grade(&harness, &white, &[("u_gamma", number(2.0))]), 32, 32), [255, 255, 255, 255], 0, "gamma white");
}

#[test]
fn grade_contrast_is_an_s_curve_that_never_clips() {
    let Some(harness) = harness() else { return };
    let ramp = image(|x, _| {
        let value = ((x * 255) / (SIZE - 1)) as u8;
        [value, value, value, 255]
    });
    let output = grade(&harness, &ramp, &[("u_contrast", number(0.5))]);
    assert_eq!(at(&output, 0, 8)[0], 0, "black stays black");
    assert_eq!(at(&output, SIZE - 1, 8)[0], 255, "white stays white");
    let mut previous = 0u8;
    for x in 0..SIZE {
        let value = at(&output, x, 8)[0];
        assert!(value >= previous, "monotonic: x {x} gave {value} after {previous}");
        previous = value;
    }
    // darks darker, lights lighter, mid grey (x 32 = 129) about where it was
    assert!(at(&output, 12, 8)[0] + 8 < at(&ramp, 12, 8)[0], "shadows go down");
    assert!(at(&output, 52, 8)[0] > at(&ramp, 52, 8)[0] + 8, "highlights go up");
    assert!(at(&output, 32, 8)[0].abs_diff(at(&ramp, 32, 8)[0]) <= 3, "mid grey holds");
    // negative contrast flattens toward grey
    let flatter = grade(&harness, &ramp, &[("u_contrast", number(-0.5))]);
    assert!(at(&flatter, 12, 8)[0] > at(&ramp, 12, 8)[0] + 8, "shadows come up when flattened");
}

#[test]
fn grade_vignette_darkens_corners_not_centre() {
    let Some(harness) = harness() else { return };
    let grey = flat([200, 200, 200, 255]);
    let output = grade(&harness, &grey, &[("u_vignette", number(1.0))]);
    assert_close(at(&output, 32, 32), [200, 200, 200, 255], 1, "centre untouched");
    assert!(at(&output, 0, 0)[0] < 60, "corner darkened, got {:?}", at(&output, 0, 0));
    assert!(at(&output, 0, 32)[0] < at(&output, 16, 32)[0], "falls off toward the edge");
    let light = grade(&harness, &grey, &[("u_vignette", number(-1.0))]);
    assert!(at(&light, 0, 0)[0] > 220, "negative vignette lightens the corner, got {:?}", at(&light, 0, 0));
}

#[test]
fn grade_grain_is_deterministic_per_seed_and_keeps_the_mean() {
    let Some(harness) = harness() else { return };
    let grey = flat([128, 128, 128, 255]);
    let uniforms = |seed: f32| vec![("u_grain", number(1.0)), ("u_grain_seed", number(seed))];
    let first = grade(&harness, &grey, &uniforms(1.0));
    let again = grade(&harness, &grey, &uniforms(1.0));
    let other = grade(&harness, &grey, &uniforms(1.0 + 1.0 / 30.0));
    assert_eq!(first, again, "same seed, same grain");
    let differing = first.iter().zip(&other).filter(|(a, b)| a[0] != b[0]).count();
    assert!(differing > first.len() / 2, "next frame's seed changes the pattern ({differing} px differ)");
    let values: Vec<f32> = first.iter().map(|p| p[0] as f32).collect();
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    let variance = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / values.len() as f32;
    assert!((mean - 128.0).abs() < 2.0, "grain keeps the mean, got {mean}");
    assert!(variance.sqrt() > 4.0, "grain is visible, std {}", variance.sqrt());
    assert!(first.iter().all(|p| p[0] == p[1] && p[1] == p[2]), "grain is monochrome");
}

#[test]
fn grade_amount_zero_returns_the_source_and_alpha_is_kept() {
    let Some(harness) = harness() else { return };
    let card = image(|x, y| [(x * 4) as u8, (y * 4) as u8, 90, ((x + y) * 2) as u8]);
    let heavy = [
        ("u_exposure", number(1.5)),
        ("u_contrast", number(0.8)),
        ("u_saturation", number(0.2)),
        ("u_temperature", number(-0.7)),
        ("u_vignette", number(0.9)),
        ("u_grain", number(0.6)),
        ("u_grain_seed", number(3.0)),
    ];
    let mut off = heavy.to_vec();
    off.push(("u_amount", number(0.0)));
    assert_images_close(&grade(&harness, &card, &off), &card, 1, "amount 0");
    let graded = grade(&harness, &card, &heavy);
    for (out, input) in graded.iter().zip(&card) {
        assert_eq!(out[3], input[3], "alpha passes through");
    }
}

#[test]
fn grade_matches_the_cpu_reference_for_a_full_look() {
    let Some(harness) = harness() else { return };
    let card = colour_card();
    let looks = [
        // warm, soft, lifted
        Look {
            exposure: 0.1,
            contrast: -0.12,
            saturation: 1.05,
            temperature: 0.3,
            tint: 0.05,
            lift: 0.04,
            gamma: 1.05,
            gain: 1.0,
            vignette: 0.15,
            amount: 1.0,
            split: [0.08, 0.15, 0.09, 0.25],
        },
        // dark, cool, desaturated, half strength
        Look {
            exposure: -0.6,
            contrast: 0.25,
            saturation: 0.7,
            temperature: -0.2,
            tint: -0.05,
            lift: -0.02,
            gamma: 0.95,
            gain: 0.95,
            vignette: 0.45,
            amount: 0.5,
            split: [0.53, 0.4, 0.08, 0.2],
        },
        // every control pushed hard (catches a wrong constant in any stage)
        Look {
            exposure: 0.7,
            contrast: 0.6,
            saturation: 1.6,
            temperature: 0.8,
            tint: -0.6,
            lift: 0.12,
            gamma: 0.6,
            gain: 0.8,
            vignette: -0.8,
            amount: 1.0,
            split: [0.6, 1.0, 0.1, 1.0],
        },
    ];
    for (index, look) in looks.iter().enumerate() {
        let output = grade(&harness, &card, &look.uniforms());
        for y in 0..SIZE {
            for x in 0..SIZE {
                let expected = reference(look, at(&card, x, y), uv_of(x, y));
                assert_close(at(&output, x, y), expected, 2, &format!("look {index} at ({x}, {y})"));
            }
        }
    }
}
