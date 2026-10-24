// RestorffCut transition "glitch": a digital-error cut. Around the cut (progress 0.5)
// horizontal bands tear sideways, the red and blue channels split, and random bands show
// the other frame for a few frames; all of it scales with sin^2(pi * progress), so both
// ends are clean. The pattern changes in 14 steps across the transition (a stepped,
// "video" feel instead of smooth noise).
//
// Uniform packing (shader id "restorff-transition-glitch"):
//   params0.x = u_strength (0..2, 1 = default)

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

const PI: f32 = 3.14159265;
const BANDS: f32 = 28.0;
const STEPS: f32 = 14.0;
const MAX_SHIFT: f32 = 0.12;
const MAX_SPLIT: f32 = 0.025;

fn hash(value: vec2f) -> f32 {
    let q = fract(value * vec2f(0.1031, 0.1030));
    let r = q + dot(q, q.yx + 33.33);
    return fract((r.x + r.y) * r.x);
}

fn pick(use_to: bool, uv: vec2f) -> vec4f {
    if (use_to) {
        return textureSampleLevel(to_texture, to_sampler, uv, 0.0);
    }
    return textureSampleLevel(from_texture, from_sampler, uv, 0.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    let strength = clamp(uniforms.params0.x, 0.0, 2.0);
    let s = sin(PI * p);
    let amount = strength * s * s;
    let step_index = floor(p * STEPS);
    let band = floor(input.tex_coord.y * BANDS);
    let torn = step(1.0 - 0.6 * min(amount, 1.0), hash(vec2f(band, step_index)));
    let shift = (hash(vec2f(band + 7.0, step_index)) - 0.5) * 2.0 * MAX_SHIFT * amount * torn;
    let flip = torn * step(0.5, hash(vec2f(band + 19.0, step_index))) * step(0.2, amount);
    let use_to = (p >= 0.5) != (flip > 0.5);
    let split = MAX_SPLIT * amount;
    let uv = input.tex_coord + vec2f(shift, 0.0);
    let green = pick(use_to, uv);
    if (split <= 0.0) {
        return green;
    }
    let red = pick(use_to, uv + vec2f(split, 0.0));
    let blue = pick(use_to, uv - vec2f(split, 0.0));
    return vec4f(red.r, green.g, blue.b, green.a);
}
