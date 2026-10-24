// RestorffCut "Glass Type": a frosted-glass panel (blur + brightness lift + tint + a soft
// inner border) inside a rounded rectangle, meant to sit behind text. Put it on an effect
// layer below the text track (or on the clip itself); pixels outside the panel pass through.
//
// The frost is a single-pass 48-tap Vogel-disk blur with a per-pixel rotation (interleaved
// gradient noise), so it needs no second pass and reads as fine grain rather than banding.
// Only pixels inside the panel run the blur loop.
//
// Uniform packing (see `shaders.rs`, shader id "restorff-glass-panel"):
//   params0      = u_rect           (x, y, width, height; 0..1 frame fractions, top-left origin)
//   params1.x    = u_corner_radius  (pixels)
//   params1.y    = u_blur           (frost radius, pixels)
//   params1.z    = u_brightness     (0..1 lift toward white)
//   params1.w    = u_border_width   (pixels)
//   params2      = u_tint           (linear r, g, b, strength 0..1)
//   params3.x    = u_border_opacity (0..1)
//   params3.y    = u_softness       (edge anti-alias width, pixels)

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
    params0: vec4f,
    params1: vec4f,
    params2: vec4f,
    params3: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const FROST_TAPS: i32 = 48;
const GOLDEN_ANGLE: f32 = 2.39996323;
const TAU: f32 = 6.28318531;

fn rounded_rect_sdf(point: vec2f, half_size: vec2f, radius: f32) -> f32 {
    let corner = min(radius, min(half_size.x, half_size.y));
    let q = abs(point) - half_size + vec2f(corner, corner);
    return length(max(q, vec2f(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - corner;
}

fn interleaved_gradient_noise(pixel: vec2f) -> f32 {
    return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let resolution = max(uniforms.resolution, vec2f(1.0, 1.0));
    let original = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);

    let rect = uniforms.params0;
    let corner_radius = max(uniforms.params1.x, 0.0);
    let blur_radius = max(uniforms.params1.y, 0.0);
    let brightness = clamp(uniforms.params1.z, 0.0, 1.0);
    let border_width = max(uniforms.params1.w, 0.0);
    let tint = clamp(uniforms.params2, vec4f(0.0, 0.0, 0.0, 0.0), vec4f(1.0, 1.0, 1.0, 1.0));
    let border_opacity = clamp(uniforms.params3.x, 0.0, 1.0);
    let softness = max(uniforms.params3.y, 0.5);

    let pixel = input.tex_coord * resolution;
    let half_size = max(rect.zw, vec2f(0.0, 0.0)) * 0.5 * resolution;
    let panel_center = rect.xy * resolution + half_size;
    let edge_distance = rounded_rect_sdf(pixel - panel_center, half_size, corner_radius);
    let mask = 1.0 - smoothstep(-softness, softness, edge_distance);
    if (mask <= 0.0) {
        return original;
    }

    var frosted = original;
    if (blur_radius >= 0.5) {
        let rotation = interleaved_gradient_noise(pixel) * TAU;
        var sum = vec4f(0.0, 0.0, 0.0, 0.0);
        var total_weight = 0.0;
        for (var index = 0; index < FROST_TAPS; index = index + 1) {
            let normalized_radius = sqrt((f32(index) + 0.5) / f32(FROST_TAPS));
            let angle = f32(index) * GOLDEN_ANGLE + rotation;
            let offset = vec2f(cos(angle), sin(angle)) * normalized_radius * blur_radius;
            let weight = exp(-2.0 * normalized_radius * normalized_radius);
            sum = sum + textureSampleLevel(input_texture, input_sampler, (pixel + offset) / resolution, 0.0) * weight;
            total_weight = total_weight + weight;
        }
        frosted = sum / total_weight;
    }

    var glass = frosted.rgb + (vec3f(1.0, 1.0, 1.0) - frosted.rgb) * brightness;
    glass = mix(glass, tint.rgb, tint.a);

    // Soft inner border: strongest at the panel edge, fading inward over border_width.
    let inside_depth = -edge_distance;
    let border = (1.0 - smoothstep(border_width - softness, border_width + softness, inside_depth)) * step(0.0001, border_width);
    glass = mix(glass, vec3f(1.0, 1.0, 1.0), border * border_opacity);

    let panel = vec4f(glass, max(frosted.a, original.a));
    return mix(original, panel, mask);
}
