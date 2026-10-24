// RestorffCut transition "flash": a hard cut hidden under an exposure flash. Brightness
// rises to a peak at progress 0.5 (where the cut happens) and falls away again; the flash
// is additive light, so highlights blow out to white first, like a camera flash or a
// light leak. Short durations (4-8 frames) are the usual use on a beat.
//
// Uniform packing (shader id "restorff-transition-flash"):
//   params0.x = u_intensity (0..2, peak added light; 1 = near-white at the cut)

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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    let intensity = clamp(uniforms.params0.x, 0.0, 2.0);
    var color = textureSampleLevel(from_texture, from_sampler, input.tex_coord, 0.0);
    if (p >= 0.5) {
        color = textureSampleLevel(to_texture, to_sampler, input.tex_coord, 0.0);
    }
    // 0 at both ends, 1 at the cut.
    let peak = 1.0 - abs(2.0 * p - 1.0);
    let glow = peak * peak * intensity;
    let lit = color.rgb * (1.0 + glow * 2.0) + vec3f(glow);
    return vec4f(clamp(lit, vec3f(0.0), vec3f(1.0)), color.a);
}
