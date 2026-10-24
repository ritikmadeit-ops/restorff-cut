// RestorffCut transition "dip": fade the outgoing frame to a flat colour, then fade the
// incoming frame up from it (dip to black / dip to white). The colour is fully reached at
// progress 0.5, where the cut happens.
//
// Uniform packing (shader id "restorff-transition-dip"):
//   params0 = u_color (sRGB r, g, b, alpha of the dip colour; default opaque black)

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
    let color = clamp(uniforms.params0, vec4f(0.0), vec4f(1.0));
    if (p < 0.5) {
        let a = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
        return mix_straight(a, color, smoothstep(0.0, 1.0, p * 2.0));
    }
    let b = textureSampleLevel(to_texture, to_sampler, input.tex_coord, 0.0);
    return mix_straight(color, b, smoothstep(0.0, 1.0, p * 2.0 - 1.0));
}
