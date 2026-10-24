// RestorffCut transition "dissolve": a straight cross-dissolve from the outgoing frame
// (`from`) to the incoming frame (`to`). Progress is linear; it is mixed in premultiplied
// space so transparent edges do not darken.
//
// Every transition shader shares this contract (see `transitions.rs`):
//   group 0 = the outgoing frame + sampler, group 1 = the incoming frame + sampler,
//   group 2 = TransitionUniforms (48 bytes). progress 0 must return `from` exactly and
//   progress 1 must return `to` exactly (the GPU render tests check both ends).
// Uniform packing (shader id "restorff-transition-dissolve"): none.

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
    let a = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
    let b = textureSampleLevel(to_texture, to_sampler, input.tex_coord, 0.0);
    return mix_straight(a, b, p);
}
