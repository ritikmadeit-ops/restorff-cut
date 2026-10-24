// RestorffCut transition "zoom": a zoom-through cut. The outgoing frame accelerates into
// the centre (ease-in, growing radial blur); the incoming frame arrives already zoomed
// and settles to 1x (ease-out, blur dying away). The two meet at progress 0.5 at full
// zoom and full blur, with a short cross-fade around the meeting point.
//
// Uniform packing (shader id "restorff-transition-zoom"):
//   params0.xy = u_center   (zoom centre, 0..1 frame fractions)
//   params0.z  = u_strength (extra scale at the cut: 1 = 2x, 2 = 3x)
//   params0.w  = u_blur     (0..1 radial blur at full speed)

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

const BLUR_TAPS: i32 = 12;
const MAX_BLUR_SPREAD: f32 = 0.18;
const FADE_START: f32 = 0.42;
const FADE_END: f32 = 0.58;

fn zoomed(use_to: bool, uv: vec2f, center: vec2f, scale: f32, spread: f32) -> vec4f {
    var rgb = vec3f(0.0);
    var alpha = 0.0;
    let taps = select(BLUR_TAPS, 1, spread <= 0.0);
    let last = f32(max(taps - 1, 1));
    for (var index = 0; index < taps; index = index + 1) {
        let f = 1.0 + spread * (f32(index) / last);
        let sample_uv = center + (uv - center) / (scale * f);
        var tap = textureSampleLevel(from_texture, from_sampler, sample_uv, 0.0);
        if (use_to) {
            tap = textureSampleLevel(to_texture, to_sampler, sample_uv, 0.0);
        }
        rgb = rgb + tap.rgb * tap.a;
        alpha = alpha + tap.a;
    }
    let out_alpha = alpha / f32(taps);
    let out_rgb = select(vec3f(0.0), rgb / max(alpha, 0.00001), alpha > 0.00001);
    return vec4f(out_rgb, out_alpha);
}

// Outgoing side at x in [0, 1] (0 = untouched, 1 = at the cut).
fn outgoing(uv: vec2f, center: vec2f, strength: f32, blur: f32, x: f32) -> vec4f {
    let scale = 1.0 + strength * x * x * x;
    let speed = x * x; // d/dx x^3 / 3
    return zoomed(false, uv, center, scale, blur * speed * MAX_BLUR_SPREAD);
}

// Incoming side at y in [0, 1] (0 = at the cut, 1 = settled).
fn incoming(uv: vec2f, center: vec2f, strength: f32, blur: f32, y: f32) -> vec4f {
    let r = 1.0 - y;
    let scale = 1.0 + strength * r * r * r;
    let speed = r * r;
    return zoomed(true, uv, center, scale, blur * speed * MAX_BLUR_SPREAD);
}

fn mix_straight(a: vec4f, b: vec4f, t: f32) -> vec4f {
    let alpha = mix(a.a, b.a, t);
    let rgb = mix(a.rgb * a.a, b.rgb * b.a, t);
    return vec4f(select(vec3f(0.0), rgb / alpha, alpha > 0.00001), alpha);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    let center = clamp(uniforms.params0.xy, vec2f(0.0), vec2f(1.0));
    let strength = max(uniforms.params0.z, 0.0);
    let blur = clamp(uniforms.params0.w, 0.0, 1.0);
    let x = clamp(p * 2.0, 0.0, 1.0);
    let y = clamp(p * 2.0 - 1.0, 0.0, 1.0);
    if (p <= FADE_START) {
        return outgoing(input.tex_coord, center, strength, blur, x);
    }
    if (p >= FADE_END) {
        return incoming(input.tex_coord, center, strength, blur, y);
    }
    let a = outgoing(input.tex_coord, center, strength, blur, x);
    let b = incoming(input.tex_coord, center, strength, blur, y);
    return mix_straight(a, b, smoothstep(FADE_START, FADE_END, p));
}
