//! A whole frame through the compositor: JSON exactly as TypeScript's frame-descriptor.ts
//! builds it (a background layer, then a `transition` item whose sides are layers), parsed
//! with serde and rendered on a headless host GPU. Checks that each side is composited
//! over the scene below it and that the mix replaces the scene. Without a GPU adapter the
//! render tests print "skipping" and pass; the JSON test always runs.

use compositor::{Compositor, FrameDescriptor, FrameItemDescriptor};
use gpu::{GpuContext, wgpu};

const W: u32 = 64; // copy_texture_to_buffer needs 256-byte rows
const H: u32 = 64;

fn frame_json(progress: f32, shader: &str, from_width: f32) -> String {
    format!(
        r#"{{
        "width": {W}, "height": {H},
        "clear": {{ "color": [0, 0, 0, 1] }},
        "items": [
          {{ "type": "layer", "textureId": "bg",
             "transform": {{ "centerX": 32, "centerY": 32, "width": 64, "height": 64,
                             "rotationDegrees": 0, "flipX": false, "flipY": false }},
             "opacity": 1, "blendMode": "normal", "effectPassGroups": [], "mask": null }},
          {{ "type": "transition", "shader": "{shader}", "progress": {progress},
             "uniforms": {{}},
             "from": [ {{ "type": "layer", "textureId": "a",
                "transform": {{ "centerX": 32, "centerY": 32, "width": {from_width}, "height": 64,
                                "rotationDegrees": 0, "flipX": false, "flipY": false }},
                "opacity": 1, "blendMode": "normal", "effectPassGroups": [], "mask": null }} ],
             "to": [ {{ "type": "layer", "textureId": "b",
                "transform": {{ "centerX": 32, "centerY": 32, "width": 64, "height": 64,
                                "rotationDegrees": 0, "flipX": false, "flipY": false }},
                "opacity": 1, "blendMode": "normal", "effectPassGroups": [], "mask": null }} ] }}
        ]
      }}"#
    )
}

#[test]
fn typescript_transition_item_parses() {
    let frame: FrameDescriptor = serde_json::from_str(&frame_json(0.25, "restorff-transition-dissolve", 64.0))
        .expect("frame descriptor parses");
    assert_eq!(frame.items.len(), 2);
    let FrameItemDescriptor::Transition(transition) = &frame.items[1] else {
        panic!("second item is a transition");
    };
    assert_eq!(transition.shader, "restorff-transition-dissolve");
    assert_eq!(transition.progress, 0.25);
    assert_eq!(transition.from.len(), 1);
    assert_eq!(transition.to[0].texture_id, "b");

    // `uniforms`, `from` and `to` may be omitted.
    let minimal: FrameDescriptor = serde_json::from_str(
        r#"{"width":2,"height":2,"clear":{"color":[0,0,0,1]},
            "items":[{"type":"transition","shader":"restorff-transition-dip","progress":1}]}"#,
    )
    .expect("minimal transition parses");
    assert!(matches!(&minimal.items[0], FrameItemDescriptor::Transition(t) if t.from.is_empty()));
}

struct Harness {
    context: GpuContext,
    compositor: Compositor,
}

fn solid(context: &GpuContext, rgba: [u8; 4]) -> wgpu::Texture {
    let texture = context.create_render_texture(W, H, "test-solid");
    let swap = context.texture_format() == wgpu::TextureFormat::Bgra8Unorm;
    let pixel = if swap { [rgba[2], rgba[1], rgba[0], rgba[3]] } else { rgba };
    let bytes: Vec<u8> = (0..W * H).flat_map(|_| pixel).collect();
    context.queue().write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(W * 4),
            rows_per_image: Some(H),
        },
        wgpu::Extent3d {
            width: W,
            height: H,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn harness() -> Option<Harness> {
    let context = match pollster::block_on(GpuContext::new()) {
        Ok(context) => context,
        Err(error) => {
            eprintln!("skipping compositor GPU test: {error}");
            return None;
        }
    };
    let mut compositor = Compositor::new(&context);
    compositor.upsert_texture("bg".into(), solid(&context, [0, 0, 255, 255]));
    compositor.upsert_texture("a".into(), solid(&context, [255, 0, 0, 255]));
    compositor.upsert_texture("b".into(), solid(&context, [0, 255, 0, 255]));
    Some(Harness { context, compositor })
}

fn render(harness: &mut Harness, json: &str) -> Vec<[u8; 4]> {
    let frame: FrameDescriptor = serde_json::from_str(json).expect("frame parses");
    let texture = harness
        .compositor
        .render_frame_to_texture(&harness.context, &frame)
        .expect("frame renders");
    let device = harness.context.device();
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("test-readback"),
        size: u64::from(W * H * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(W * 4),
                rows_per_image: Some(H),
            },
        },
        wgpu::Extent3d {
            width: W,
            height: H,
            depth_or_array_layers: 1,
        },
    );
    harness.context.queue().submit([encoder.finish()]);
    buffer.map_async(wgpu::MapMode::Read, .., |result| result.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let swap = harness.context.texture_format() == wgpu::TextureFormat::Bgra8Unorm;
    let pixels = buffer
        .get_mapped_range(..)
        .chunks_exact(4)
        .map(|p| if swap { [p[2], p[1], p[0], p[3]] } else { [p[0], p[1], p[2], p[3]] })
        .collect();
    buffer.unmap();
    pixels
}

fn close(actual: [u8; 4], expected: [u8; 4], what: &str) {
    for channel in 0..4 {
        assert!(actual[channel].abs_diff(expected[channel]) <= 2, "{what}: got {actual:?}, expected {expected:?}");
    }
}

#[test]
fn dissolve_mixes_the_two_sides_over_the_scene() {
    let Some(mut harness) = harness() else { return };
    let start = render(&mut harness, &frame_json(0.0, "restorff-transition-dissolve", 64.0));
    close(start[32 * 64 + 32], [255, 0, 0, 255], "progress 0 = outgoing clip");
    let end = render(&mut harness, &frame_json(1.0, "restorff-transition-dissolve", 64.0));
    close(end[32 * 64 + 32], [0, 255, 0, 255], "progress 1 = incoming clip");
    let middle = render(&mut harness, &frame_json(0.5, "restorff-transition-dissolve", 64.0));
    close(middle[32 * 64 + 32], [128, 128, 0, 255], "half-way = average");
}

#[test]
fn transparent_parts_of_a_side_show_the_scene_below() {
    let Some(mut harness) = harness() else { return };
    // The outgoing clip covers only the middle 32 px (a pillarboxed clip); at progress 0
    // the bars must show the blue background, not black or a darkened mix.
    let start = render(&mut harness, &frame_json(0.0, "restorff-transition-dissolve", 32.0));
    close(start[32 * 64 + 32], [255, 0, 0, 255], "inside the clip");
    close(start[32 * 64 + 4], [0, 0, 255, 255], "bar shows the background");
    let middle = render(&mut harness, &frame_json(0.5, "restorff-transition-dissolve", 32.0));
    close(middle[32 * 64 + 4], [0, 128, 128, 255], "bar half-way: background into the incoming clip");
}

#[test]
fn an_unknown_transition_shader_is_an_error_not_a_panic() {
    let Some(mut harness) = harness() else { return };
    let frame: FrameDescriptor =
        serde_json::from_str(&frame_json(0.5, "restorff-transition-nope", 64.0)).expect("parses");
    let error = harness
        .compositor
        .render_frame_to_texture(&harness.context, &frame)
        .expect_err("unknown shader fails");
    assert!(error.to_string().contains("restorff-transition-nope"), "{error}");
}
