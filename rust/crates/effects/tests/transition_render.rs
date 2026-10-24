//! Renders every transition on a headless host GPU (same WGSL as the browser) and checks
//! the contract: progress 0 is the outgoing frame, progress 1 is the incoming frame, and a
//! few shader-specific properties in between. Without a GPU adapter each test prints
//! "skipping" and passes; run with `--nocapture` to see the adapter.

use std::collections::HashMap;

use effects::{
    ApplyTransitionOptions, DIP_TRANSITION_ID, DISSOLVE_TRANSITION_ID, IRIS_TRANSITION_ID,
    SLIDE_TRANSITION_ID, TRANSITION_SHADERS, TransitionPipeline, UniformValue, WHIP_TRANSITION_ID,
    WIPE_TRANSITION_ID, ZOOM_TRANSITION_ID,
};
use gpu::{GpuContext, wgpu};

const SIZE: u32 = 64;

struct Harness {
    context: GpuContext,
    pipeline: TransitionPipeline,
}

fn harness() -> Option<Harness> {
    match pollster::block_on(GpuContext::new()) {
        Ok(context) => {
            let info = context.adapter().get_info();
            eprintln!("GPU transition test on {} ({:?})", info.name, info.backend);
            let pipeline = TransitionPipeline::new(&context);
            Some(Harness { context, pipeline })
        }
        Err(error) => {
            eprintln!("skipping GPU transition test: {error}");
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

fn render(
    harness: &Harness,
    from: &Image,
    to: &Image,
    shader: &str,
    progress: f32,
    uniforms: &[(&str, UniformValue)],
) -> Image {
    let from_texture = upload(harness, from);
    let to_texture = upload(harness, to);
    let uniforms = uniforms
        .iter()
        .map(|(name, value)| (name.to_string(), value.clone()))
        .collect::<HashMap<_, _>>();
    let output = harness
        .pipeline
        .apply(
            &harness.context,
            ApplyTransitionOptions {
                from: &from_texture,
                to: &to_texture,
                width: SIZE,
                height: SIZE,
                shader,
                progress,
                uniforms: &uniforms,
            },
        )
        .expect("transition applies");
    read_back(harness, &output)
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

/// Red/green ramps: every pixel is different, so any shift or blur shows.
fn outgoing() -> Image {
    image(|x, y| [(x * 4) as u8, (y * 4) as u8, 40, 255])
}

/// A different pattern: blue-heavy checker.
fn incoming() -> Image {
    image(|x, y| if (x / 8 + y / 8) % 2 == 0 { [20, 200, 230, 255] } else { [10, 60, 180, 255] })
}

fn vector(values: &[f32]) -> UniformValue {
    UniformValue::Vector(values.to_vec())
}

#[test]
fn every_transition_starts_on_the_outgoing_frame_and_ends_on_the_incoming_frame() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    for spec in TRANSITION_SHADERS {
        let start = render(&harness, &from, &to, spec.id, 0.0, &[]);
        assert_images_close(&start, &from, 1, &format!("{} at progress 0", spec.id));
        let end = render(&harness, &from, &to, spec.id, 1.0, &[]);
        assert_images_close(&end, &to, 1, &format!("{} at progress 1", spec.id));
        // Mid-way the picture must be neither untouched frame.
        let middle = render(&harness, &from, &to, spec.id, 0.5, &[]);
        assert!(middle != from && middle != to, "{} changes the picture mid-way", spec.id);
    }
}

#[test]
fn dissolve_is_the_average_half_way() {
    let Some(harness) = harness() else { return };
    let from = image(|_, _| [200, 0, 100, 255]);
    let to = image(|_, _| [0, 200, 50, 255]);
    let middle = render(&harness, &from, &to, DISSOLVE_TRANSITION_ID, 0.5, &[]);
    assert_close(at(&middle, 10, 10), [100, 100, 75, 255], 2, "dissolve at 0.5");
}

#[test]
fn dip_reaches_its_colour_at_the_cut() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    let black = render(&harness, &from, &to, DIP_TRANSITION_ID, 0.5, &[]);
    assert_images_close(&black, &image(|_, _| [0, 0, 0, 255]), 1, "dip to black at 0.5");
    let white = render(&harness, &from, &to, DIP_TRANSITION_ID, 0.5, &[("u_color", vector(&[1.0, 1.0, 1.0, 1.0]))]);
    assert_images_close(&white, &image(|_, _| [255, 255, 255, 255]), 1, "dip to white at 0.5");
}

#[test]
fn whip_without_blur_is_an_exact_push_half_way() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    // Push left: at progress 0.5 (eased offset 0.5) the left half shows the right half of
    // the outgoing frame and the right half shows the left half of the incoming frame.
    let output = render(
        &harness,
        &from,
        &to,
        WHIP_TRANSITION_ID,
        0.5,
        &[("u_direction", vector(&[-1.0, 0.0])), ("u_blur", UniformValue::Number(0.0))],
    );
    for y in [3, 30, 60] {
        assert_close(at(&output, 5, y), at(&from, 37, y), 2, "left half = outgoing shifted");
        assert_close(at(&output, 40, y), at(&to, 8, y), 2, "right half = incoming shifted");
    }
}

#[test]
fn whip_blurs_along_its_direction_only() {
    let Some(harness) = harness() else { return };
    // Vertical stripes blur under a horizontal whip; horizontal stripes do not.
    let vertical = image(|x, _| if (x / 2) % 2 == 0 { [255, 255, 255, 255] } else { [0, 0, 0, 255] });
    let horizontal = image(|_, y| if (y / 2) % 2 == 0 { [255, 255, 255, 255] } else { [0, 0, 0, 255] });
    let uniforms = [("u_direction", vector(&[-1.0, 0.0])), ("u_blur", UniformValue::Number(1.0))];
    let blurred = render(&harness, &vertical, &vertical, WHIP_TRANSITION_ID, 0.5, &uniforms);
    let spread = |image: &Image| {
        let values: Vec<u8> = (0..SIZE).map(|x| at(image, x, 20)[0]).collect();
        values.iter().max().unwrap() - values.iter().min().unwrap()
    };
    assert!(spread(&blurred) < 60, "vertical stripes are smeared (spread {})", spread(&blurred));
    let sharp = render(&harness, &horizontal, &horizontal, WHIP_TRANSITION_ID, 0.5, &uniforms);
    let column: Vec<u8> = (0..SIZE).map(|y| at(&sharp, 20, y)[0]).collect();
    assert!(column.iter().max().unwrap() - column.iter().min().unwrap() > 200, "horizontal stripes stay sharp");
}

#[test]
fn slide_covers_from_the_entering_side() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    // Enters from the right moving left; half-way (eased 0.875 travelled) most of the frame is
    // the incoming one, the far left is still the outgoing one, untouched by any shift.
    let output = render(&harness, &from, &to, SLIDE_TRANSITION_ID, 0.5, &[("u_direction", vector(&[-1.0, 0.0]))]);
    assert_close(at(&output, 60, 30), at(&to, 52, 30), 2, "right side shows the incoming frame, shifted");
    assert_close(at(&output, 2, 30), at(&from, 2, 30), 2, "left edge still shows the outgoing frame");
}

#[test]
fn wipe_reveals_from_the_trailing_side() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    let output = render(&harness, &from, &to, WIPE_TRANSITION_ID, 0.5, &[("u_softness", UniformValue::Number(0.02))]);
    assert_close(at(&output, 4, 30), at(&to, 4, 30), 1, "left of the edge is the incoming frame");
    assert_close(at(&output, 60, 30), at(&from, 60, 30), 1, "right of the edge is the outgoing frame");
}

#[test]
fn iris_opens_from_the_centre() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    let output = render(&harness, &from, &to, IRIS_TRANSITION_ID, 0.4, &[]);
    assert_close(at(&output, 32, 32), at(&to, 32, 32), 1, "centre is the incoming frame");
    assert_close(at(&output, 0, 0), at(&from, 0, 0), 1, "corner is still the outgoing frame");
}

#[test]
fn zoom_keeps_its_centre_and_pushes_into_it() {
    let Some(harness) = harness() else { return };
    let (from, to) = (outgoing(), incoming());
    // Before the cross-fade the outgoing frame is magnified about the centre: the centre
    // pixel stays, a pixel near the edge now shows content from nearer the centre.
    let output = render(&harness, &from, &to, ZOOM_TRANSITION_ID, 0.35, &[("u_blur", UniformValue::Number(0.0))]);
    assert_close(at(&output, 32, 32), at(&from, 32, 32), 3, "zoom centre is fixed");
    let edge = at(&output, 60, 32)[0];
    assert!(edge < at(&from, 60, 32)[0], "edge pixel samples nearer the centre ({edge})");
    assert!(edge > at(&from, 32, 32)[0], "but still right of the centre ({edge})");
}
