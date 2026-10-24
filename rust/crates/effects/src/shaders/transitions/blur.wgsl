// RestorffCut transition "blur": a cross-blur dissolve. The outgoing frame defocuses as
// the incoming one fades up out of focus and sharpens; the blur radius follows
// sin(pi * progress), so both ends are sharp. One pass, 16 Vogel-disk taps per frame.
//
// Uniform packing (shader id "restorff-transition-blur"):
//   params0.x = u_strength (largest blur radius as a fraction of the frame's short side)

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
const TAPS: i32 = 16;
const GOLDEN_ANGLE: f32 = 2.39996323;

fn mix_straight(a: vec4f, b: vec4f, t: f32) -> vec4f {
    let alpha = mix(a.a, b.a, t);
    let rgb = mix(a.rgb * a.a, b.rgb * b.a, t);
    return vec4f(select(vec3f(0.0), rgb / alpha, alpha > 0.00001), alpha);
}

fn blurred(use_to: bool, uv: vec2f, radius: vec2f) -> vec4f {
    let taps = select(TAPS, 1, radius.x <= 0.0);
    var rgb = vec3f(0.0);
    var alpha = 0.0;
    for (var index = 0; index < taps; index = index + 1) {
        let r = sqrt((f32(index) + 0.5) / f32(taps));
        let theta = f32(index) * GOLDEN_ANGLE;
        let offset = select(vec2f(0.0), vec2f(cos(theta), sin(theta)) * r * radius, taps > 1);
        var tap = textureSampleLevel(from_texture, from_sampler, uv + offset, 0.0);
        if (use_to) {
            tap = textureSampleLevel(to_texture, to_sampler, uv + offset, 0.0);
        }
        rgb = rgb + tap.rgb * tap.a;
        alpha = alpha + tap.a;
    }
    let out_alpha = alpha / f32(taps);
    let out_rgb = select(vec3f(0.0), rgb / max(alpha, 0.00001), alpha > 0.00001);
    return vec4f(out_rgb, out_alpha);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    let strength = clamp(uniforms.params0.x, 0.0, 0.2);
    let short_side = max(min(uniforms.resolution.x, uniforms.resolution.y), 1.0);
    // Radius in uv units, round in pixels.
    let radius = vec2f(short_side / uniforms.resolution.x, short_side / uniforms.resolution.y)
        * strength * sin(PI * p);
    let t = smoothstep(0.0, 1.0, p);
    if (t <= 0.0) {
        return blurred(false, input.tex_coord, radius);
    }
    if (t >= 1.0) {
        return blurred(true, input.tex_coord, radius);
    }
    return mix_straight(blurred(false, input.tex_coord, radius), blurred(true, input.tex_coord, radius), t);
}
