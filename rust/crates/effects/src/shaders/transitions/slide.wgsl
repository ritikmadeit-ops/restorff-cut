// RestorffCut transition "slide": the incoming frame slides in over the outgoing frame,
// which stays put (a "cover"), on an ease-out-cubic curve with a soft shadow on its
// leading edge.
//
// Uniform packing (shader id "restorff-transition-slide"):
//   params0.xy = u_direction (the way the incoming frame travels, e.g. (-1, 0) = enters
//                             from the right and moves left; use axis-aligned values)

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct TransitionUniforms {
    resolution: vec2f,
    progress: f32,
    padding: f32,
    params0: vec4f,
    params1: vec4f,
}

@group(0) @binding(0) var from_texture: texture_2d<f32>;
@group(0) @binding(1) var from_sampler: sampler;
@group(1) @binding(0) var to_texture: texture_2d<f32>;
@group(1) @binding(1) var to_sampler: sampler;
@group(2) @binding(0) var<uniform> uniforms: TransitionUniforms;

const SHADOW_WIDTH: f32 = 0.04;
const SHADOW_STRENGTH: f32 = 0.35;

fn ease_out_cubic(p: f32) -> f32 {
    let q = 1.0 - p;
    return 1.0 - q * q * q;
}

fn inside(uv: vec2f) -> bool {
    return uv.x >= 0.0 && uv.x < 1.0 && uv.y >= 0.0 && uv.y < 1.0;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    var direction = uniforms.params0.xy;
    if (dot(direction, direction) < 0.000001) {
        direction = vec2f(-1.0, 0.0);
    }
    direction = normalize(direction);
    let remaining = 1.0 - ease_out_cubic(p);
    // Where this pixel sits inside the incoming frame.
    let incoming = input.tex_coord + direction * remaining;
    if (inside(incoming)) {
        return textureSampleLevel(to_texture, to_sampler, incoming, 0.0);
    }
    let a = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
    // Distance (in frame fractions) from the incoming frame's leading edge.
    let edge = abs(dot(input.tex_coord - (vec2f(0.5) - direction * remaining), direction)) - 0.5;
    let shadow = SHADOW_STRENGTH * (1.0 - smoothstep(0.0, SHADOW_WIDTH, edge)) * min(remaining * 8.0, 1.0)
        * min(p * 8.0, 1.0);
    return vec4f(a.rgb * (1.0 - shadow), a.a);
}
