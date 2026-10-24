// RestorffCut transition "iris": the incoming frame opens as a soft circle from a point
// until it covers the frame. The circle is round in pixels (aspect-corrected).
//
// Uniform packing (shader id "restorff-transition-iris"):
//   params0.xy = u_center  (0..1 frame fractions)
//   params0.z  = u_feather (edge width, fraction of the frame's short side)

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

fn mix_straight(a: vec4f, b: vec4f, t: f32) -> vec4f {
    let alpha = mix(a.a, b.a, t);
    let rgb = mix(a.rgb * a.a, b.rgb * b.a, t);
    return vec4f(select(vec3f(0.0), rgb / alpha, alpha > 0.00001), alpha);
}

fn ease_in_out_quad(p: f32) -> f32 {
    if (p < 0.5) {
        return 2.0 * p * p;
    }
    let q = -2.0 * p + 2.0;
    return 1.0 - q * q * 0.5;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    let center = clamp(uniforms.params0.xy, vec2f(0.0), vec2f(1.0));
    let feather = max(uniforms.params0.z, 0.0001);
    let short_side = max(min(uniforms.resolution.x, uniforms.resolution.y), 1.0);
    let to_units = uniforms.resolution / short_side;
    let distance = length((input.tex_coord - center) * to_units);
    let farthest = length(max(center, vec2f(1.0) - center) * to_units);
    let radius = ease_in_out_quad(p) * (farthest + feather);
    let reveal = 1.0 - smoothstep(radius - feather, radius, distance);
    let a = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
    let b = textureSampleLevel(to_texture, to_sampler, input.tex_coord, 0.0);
    return mix_straight(a, b, reveal);
}
