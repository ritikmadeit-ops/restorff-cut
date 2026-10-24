//! Renders known 64x64 images through each effect on a headless host GPU (DX12 / Vulkan /
//! Metal via wgpu, same WGSL as the browser) and checks pixels against the shader math.
//! Without a GPU adapter each test prints "skipping" and passes; run with `--nocapture`
//! to see which adapter was used.

use std::collections::HashMap;

use effects::{
    ApplyEffectsOptions, DIGITAL_ZOOM_SHADER_ID, EffectPass, EffectPipeline,
    GAUSSIAN_BLUR_SHADER_ID, GLASS_PANEL_SHADER_ID, UniformValue, VERTIGO_SHADER_ID,
};
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
            eprintln!("GPU render test on {} ({:?})", info.name, info.backend);
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
    let texture = harness.context.create_render_texture(SIZE, SIZE, "test-input");
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
        label: Some("test-readback"),
        size: u64::from(SIZE * SIZE * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("test-readback-encoder"),
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

fn render(harness: &Harness, input: &Image, shader: &str, uniforms: &[(&str, UniformValue)]) -> Image {
    let source = upload(harness, input);
    let pass = EffectPass {
        shader: shader.to_string(),
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
        .expect("effect applies");
    read_back(harness, &output)
}

fn number(value: f32) -> UniformValue {
    UniformValue::Number(value)
}

fn vector(values: &[f32]) -> UniformValue {
    UniformValue::Vector(values.to_vec())
}

/// R and G encode the source x and y (4 levels per pixel), B constant.
fn coordinate_gradient() -> Image {
    image(|x, y| [(x * 4) as u8, (y * 4) as u8, 128, 255])
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

#[test]
fn gaussian_blur_still_renders_after_the_buffer_change() {
    let Some(harness) = harness() else { return };
    let flat = image(|_, _| [200, 100, 50, 255]);
    let output = render(
        &harness,
        &flat,
        GAUSSIAN_BLUR_SHADER_ID,
        &[("u_sigma", number(3.0)), ("u_step", number(1.0)), ("u_direction", vector(&[1.0, 0.0]))],
    );
    assert_images_close(&output, &flat, 1, "blurred flat colour");

    let gradient = coordinate_gradient();
    let output = render(
        &harness,
        &gradient,
        GAUSSIAN_BLUR_SHADER_ID,
        &[("u_sigma", number(3.0)), ("u_step", number(1.0)), ("u_direction", vector(&[1.0, 0.0]))],
    );
    // A symmetric blur keeps a linear ramp linear away from the edges.
    assert_close(at(&output, 32, 32), at(&gradient, 32, 32), 2, "blurred ramp centre");
}

#[test]
fn digital_zoom_is_identity_at_zoom_one() {
    let Some(harness) = harness() else { return };
    let gradient = coordinate_gradient();
    let output = render(&harness, &gradient, DIGITAL_ZOOM_SHADER_ID, &[("u_zoom", number(1.0))]);
    assert_images_close(&output, &gradient, 1, "zoom 1");
}

#[test]
fn digital_zoom_punches_in_toward_the_focal_point() {
    let Some(harness) = harness() else { return };
    let gradient = coordinate_gradient();
    let output = render(
        &harness,
        &gradient,
        DIGITAL_ZOOM_SHADER_ID,
        &[("u_focal", vector(&[0.5, 0.5])), ("u_zoom", number(2.0))],
    );
    // Output (0, 0) samples source ~(15.75, 15.75): R = G = 63.
    assert_close(at(&output, 0, 0), [63, 63, 128, 255], 3, "zoom 2 corner");
    // The focal point stays put.
    assert_close(at(&output, 32, 32), at(&gradient, 32, 32), 3, "zoom 2 focal");

    let off_centre = render(
        &harness,
        &gradient,
        DIGITAL_ZOOM_SHADER_ID,
        &[("u_focal", vector(&[0.25, 0.75])), ("u_zoom", number(3.0))],
    );
    assert_close(at(&off_centre, 16, 48), at(&gradient, 16, 48), 3, "off-centre focal stays put");
}

#[test]
fn digital_zoom_smear_blurs_away_from_the_focal_point_only() {
    let Some(harness) = harness() else { return };
    let gradient = coordinate_gradient();
    let output = render(
        &harness,
        &gradient,
        DIGITAL_ZOOM_SHADER_ID,
        &[("u_focal", vector(&[0.5, 0.5])), ("u_zoom", number(1.0)), ("u_blur", number(1.0))],
    );
    // The smear pulls samples toward the focal point: the left edge averages source x 0..~8
    // (R ~16 instead of 0) while the focal point itself does not move.
    let edge = at(&output, 0, 32)[0];
    assert!((8..=24).contains(&edge), "edge smeared toward the centre, got R={edge}");
    assert_close(at(&output, 32, 32), at(&gradient, 32, 32), 2, "focal point is sharp");
}

#[test]
fn digital_zoom_chroma_splits_red_out_and_blue_in() {
    let Some(harness) = harness() else { return };
    let ramp = image(|x, _| {
        let value = (x * 4) as u8;
        [value, value, value, 255]
    });
    let output = render(&harness, &ramp, DIGITAL_ZOOM_SHADER_ID, &[("u_chroma", number(1.0))]);
    let [r, g, b, _] = at(&output, 4, 32);
    assert!(r < g && g < b, "left edge: red sampled further out, blue further in, got {r} {g} {b}");
    let [r, g, b, _] = at(&output, 32, 32);
    assert!(r.abs_diff(g) <= 2 && g.abs_diff(b) <= 2, "centre has no split, got {r} {g} {b}");
}

#[test]
fn vertigo_is_identity_at_zero_strength() {
    let Some(harness) = harness() else { return };
    let gradient = coordinate_gradient();
    let output = render(&harness, &gradient, VERTIGO_SHADER_ID, &[("u_strength", number(0.0))]);
    assert_images_close(&output, &gradient, 1, "strength 0");
}

#[test]
fn vertigo_keeps_the_centre_and_magnifies_the_surroundings() {
    let Some(harness) = harness() else { return };
    let gradient = coordinate_gradient();
    let output = render(
        &harness,
        &gradient,
        VERTIGO_SHADER_ID,
        &[
            ("u_center", vector(&[0.5, 0.5])),
            ("u_radius", number(0.25)),
            ("u_strength", number(1.0)),
            ("u_feather", number(0.1)),
        ],
    );
    for x in [28, 32, 36] {
        assert_close(at(&output, x, 32), at(&gradient, x, 32), 1, "inside the subject radius");
    }
    // Left edge samples source x ~8.2 (see the shader math): R ~33 instead of 0.
    let edge = at(&output, 0, 32)[0];
    assert!((26..=40).contains(&edge), "edge is magnified toward the centre, got R={edge}");
    // The warp is monotonic: no fold-over along the row.
    let row: Vec<u8> = (0..SIZE).map(|x| at(&output, x, 32)[0]).collect();
    assert!(row.windows(2).all(|pair| pair[0] <= pair[1]), "row is monotonic: {row:?}");
}

#[test]
fn glass_panel_frosts_inside_and_leaves_outside_untouched() {
    let Some(harness) = harness() else { return };
    let checker = image(|x, y| if (x + y) % 2 == 0 { [0, 0, 0, 255] } else { [255, 255, 255, 255] });
    let output = render(
        &harness,
        &checker,
        GLASS_PANEL_SHADER_ID,
        &[
            ("u_rect", vector(&[0.25, 0.25, 0.5, 0.5])),
            ("u_corner_radius", number(12.0)),
            ("u_blur", number(6.0)),
            ("u_brightness", number(0.0)),
            ("u_border_width", number(0.0)),
            ("u_tint", vector(&[1.0, 1.0, 1.0, 0.0])),
        ],
    );
    for (x, y) in [(2, 2), (60, 33), (33, 8), (17, 17)] {
        // (17, 17) is inside the rect's bounds but outside its 12 px rounded corner.
        assert_eq!(at(&output, x, y), at(&checker, x, y), "outside the panel at ({x}, {y})");
    }
    for (x, y) in [(32, 32), (24, 40)] {
        let value = at(&output, x, y)[0];
        assert!((80..=176).contains(&value), "frosted checker averages to grey at ({x}, {y}), got {value}");
    }
}

#[test]
fn glass_panel_lifts_brightness_and_draws_the_border() {
    let Some(harness) = harness() else { return };
    let dark = image(|_, _| [40, 40, 40, 255]);
    let lifted = render(
        &harness,
        &dark,
        GLASS_PANEL_SHADER_ID,
        &[
            ("u_rect", vector(&[0.25, 0.25, 0.5, 0.5])),
            ("u_brightness", number(0.5)),
            ("u_border_width", number(0.0)),
            ("u_tint", vector(&[1.0, 1.0, 1.0, 0.0])),
        ],
    );
    // 40 + (255 - 40) * 0.5 = 147.5
    assert_close(at(&lifted, 32, 32), [148, 148, 148, 255], 3, "brightness lift");

    let bordered = render(
        &harness,
        &dark,
        GLASS_PANEL_SHADER_ID,
        &[
            ("u_rect", vector(&[0.25, 0.25, 0.5, 0.5])),
            ("u_corner_radius", number(0.0)),
            ("u_brightness", number(0.0)),
            ("u_border_width", number(2.0)),
            ("u_border_opacity", number(1.0)),
            ("u_tint", vector(&[1.0, 1.0, 1.0, 0.0])),
        ],
    );
    assert!(at(&bordered, 16, 32)[0] > 150, "border just inside the edge: {:?}", at(&bordered, 16, 32));
    assert_close(at(&bordered, 32, 32), [40, 40, 40, 255], 2, "panel interior without lift");
}
