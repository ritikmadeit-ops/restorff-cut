// RestorffCut transition "whip": a whip pan. Both frames travel together along
// u_direction (the outgoing frame leaves, the incoming one follows it in, edge to edge),
// on an ease-in-out-cubic curve, smeared by a directional motion blur whose length follows
// the speed of the move (zero at both ends, longest at the cut). With u_blur = 0 this is
// a clean "push".
//
// Uniform packing (shader id "restorff-transition-whip"):
//   params0.xy = u_direction (the way the picture travels on screen, e.g. (-1, 0) = left;
//                             axis-aligned values give a seamless join)
//   params0.z  = u_blur      (0..1, blur length at full speed as a fraction of the frame)

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

const BLUR_TAPS: i32 = 16;

fn ease_in_out_cubic(p: f32) -> f32 {
    if (p < 0.5) {
        return 4.0 * p * p * p;
    }
    let q = 2.0 - 2.0 * p;
    return 1.0 - q * q * q * 0.5;
}

// Derivative of ease_in_out_cubic divided by its peak (3 at p = 0.5): 0..1.
fn ease_speed(p: f32) -> f32 {
    if (p < 0.5) {
        return 4.0 * p * p;
    }
    let q = 2.0 - 2.0 * p;
    return q * q;
}

fn inside(uv: vec2f) -> bool {
    return uv.x >= 0.0 && uv.x < 1.0 && uv.y >= 0.0 && uv.y < 1.0;
}

// The two frames laid edge to edge along the direction, `from` first.
fn strip(q: vec2f, direction: vec2f) -> vec4f {
    if (inside(q)) {
        return textureSampleLevel(from_texture, from_sampler, q, 0.0);
    }
    let incoming = q + direction;
    if (inside(incoming)) {
        return textureSampleLevel(to_texture, to_sampler, incoming, 0.0);
    }
    return vec4f(0.0);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let p = clamp(uniforms.progress, 0.0, 1.0);
    var direction = uniforms.params0.xy;
    if (dot(direction, direction) < 0.000001) {
        direction = vec2f(-1.0, 0.0);
    }
    direction = normalize(direction);
    let blur = clamp(uniforms.params0.z, 0.0, 1.0) * ease_speed(p);
    let q = input.tex_coord - direction * ease_in_out_cubic(p);

    if (blur <= 0.0) {
        return strip(q, direction);
    }
    // Average in premultiplied space so the join does not darken.
    var rgb = vec3f(0.0);
    var alpha = 0.0;
    for (var index = 0; index < BLUR_TAPS; index = index + 1) {
        let t = f32(index) / f32(BLUR_TAPS - 1) - 0.5;
        let tap = strip(q + direction * (t * blur), direction);
        rgb = rgb + tap.rgb * tap.a;
        alpha = alpha + tap.a;
    }
    let out_alpha = alpha / f32(BLUR_TAPS);
    let out_rgb = select(vec3f(0.0), rgb / max(alpha, 0.00001), alpha > 0.00001);
    return vec4f(out_rgb, out_alpha);
}
