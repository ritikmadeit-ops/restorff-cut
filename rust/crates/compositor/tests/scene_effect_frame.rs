//! An effect layer (`sceneEffect` frame item, an adjustment layer: the timeline's GRADE layer, or any shader effect
//! dropped from the Effects panel) exactly as TypeScript's frame-descriptor.ts sends it, parsed with serde and
//! rendered on a headless host GPU. Regression for the upstream bug where the item's field had to be spelled
//! `effect_pass_groups` (grade agent, 2026-10-20). Without a GPU adapter the render test prints "skipping" and passes.

use compositor::{Compositor, FrameDescriptor, FrameItemDescriptor};
use gpu::{GpuContext, wgpu};

const W: u32 = 64; // copy_texture_to_buffer needs 256-byte rows
const H: u32 = 64;

/// A grey background layer, then a grade effect layer (saturation 0 + exposure +1), then a red layer above it.
fn frame_json(field: &str) -> String {
    format!(
        r#"{{
        "width": {W}, "height": {H},
        "clear": {{ "color": [0, 0, 0, 1] }},
        "items": [
          {{ "type": "layer", "textureId": "orange",
             "transform": {{ "centerX": 32, "centerY": 32, "width": 64, "height": 64,
                             "rotationDegrees": 0, "flipX": false, "flipY": false }},
             "opacity": 1, "blendMode": "normal", "effectPassGroups": [], "mask": null }},
          {{ "type": "sceneEffect", "{field}": [[
             {{ "shader": "restorff-grade", "uniforms": {{ "u_saturation": 0, "u_exposure": 0 }} }} ]] }},
          {{ "type": "layer", "textureId": "red",
             "transform": {{ "centerX": 8, "centerY": 32, "width": 16, "height": 64,
                             "rotationDegrees": 0, "flipX": false, "flipY": false }},
             "opacity": 1, "blendMode": "normal", "effectPassGroups": [], "mask": null }}
        ]
      }}"#
    )
}

#[test]
fn typescript_scene_effect_item_parses_in_both_spellings() {
    for field in ["effectPassGroups", "effect_pass_groups"] {
        let frame: FrameDescriptor = serde_json::from_str(&frame_json(field)).expect("frame descriptor parses");
        let FrameItemDescriptor::SceneEffect { effect_pass_groups } = &frame.items[1] else {
            panic!("second item is a scene effect");
        };
        assert_eq!(effect_pass_groups.len(), 1);
        assert_eq!(effect_pass_groups[0][0].shader, "restorff-grade");
    }
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

fn read(context: &GpuContext, texture: &wgpu::Texture) -> Vec<[u8; 4]> {
    let device = context.device();
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("test-readback"),
        size: u64::from(W * H * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
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
    context.queue().submit([encoder.finish()]);
    buffer.map_async(wgpu::MapMode::Read, .., |result| result.expect("map"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let swap = context.texture_format() == wgpu::TextureFormat::Bgra8Unorm;
    let pixels = buffer
        .get_mapped_range(..)
        .chunks_exact(4)
        .map(|p| if swap { [p[2], p[1], p[0], p[3]] } else { [p[0], p[1], p[2], p[3]] })
        .collect();
    buffer.unmap();
    pixels
}

#[test]
fn an_effect_layer_grades_what_is_below_it_and_not_what_is_above() {
    let context = match pollster::block_on(GpuContext::new()) {
        Ok(context) => context,
        Err(error) => {
            eprintln!("skipping compositor GPU test: {error}");
            return;
        }
    };
    let mut compositor = Compositor::new(&context);
    compositor.upsert_texture("orange".into(), solid(&context, [200, 100, 50, 255]));
    compositor.upsert_texture("red".into(), solid(&context, [255, 0, 0, 255]));
    let frame: FrameDescriptor = serde_json::from_str(&frame_json("effectPassGroups")).expect("parses");
    let texture = compositor.render_frame_to_texture(&context, &frame).expect("frame with an effect layer renders");
    let pixels = read(&context, &texture);
    // below the layer: the orange background went grey (Rec.709 luma of 200/100/50 = 117.65)
    let below = pixels[(32 * W + 48) as usize];
    for channel in 0..3 {
        assert!(below[channel].abs_diff(118) <= 2, "graded background: {below:?}");
    }
    // above the layer: the red strip keeps its colour
    let above = pixels[(32 * W + 4) as usize];
    assert!(above[0] >= 253 && above[1] <= 2 && above[2] <= 2, "ungraded layer above: {above:?}");
}
