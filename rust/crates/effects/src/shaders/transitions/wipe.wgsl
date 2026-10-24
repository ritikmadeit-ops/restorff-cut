// RestorffCut transition "wipe": a straight soft-edged wipe. The edge travels across the
// frame along u_direction; behind it is the incoming frame.
//
// Uniform packing (shader id "restorff-transition-wipe"):
//   params0.xy = u_direction (the way the edge travels, e.g. (1, 0) = left to right;
//                             diagonals work too)
//   params0.z  = u_softness  (edge width as a fraction of the travel, 0 = hard)

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    var direction = uniforms.params0.xy;
    if (dot(direction, direction) < 0.000001) {
        direction = vec2f(1.0, 0.0);
    }
    direction = normalize(direction);
    let softness = max(uniforms.params0.z, 0.0001);
    // 0 at the trailing corner of the frame, 1 at the leading corner.
    let half_extent = 0.5 * (abs(direction.x) + abs(direction.y));
    let along = dot(input.tex_coord - vec2f(0.5), direction) / (2.0 * half_extent) + 0.5;
    let edge = p * (1.0 + softness);
    let reveal = 1.0 - smoothstep(edge - softness, edge, along);
    let a = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
    let b = textureSampleLevel(to_texture, to_sampler, input.tex_coord, 0.0);
    return mix_straight(a, b, reveal);
}
