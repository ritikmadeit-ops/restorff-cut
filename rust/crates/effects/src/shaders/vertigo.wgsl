// RestorffCut "Vertigo": a dolly-zoom illusion without a subject mask. The centre region
// (the subject) keeps its size while everything outside it is magnified; keyframe
// u_strength over time to get the push/pull.
//
// The warp is radial and continuous: inside the radius the frame is untouched, outside
// it the sampling rate falls smoothly from 1 to 1/S (S = background magnification) over
// the feather band. The sampled distance is the integral of that rate, so the mapping is
// monotonic (no fold-over, no seam, no ghosting) and never samples outside the frame.
//
// Uniform packing (see `shaders.rs`, shader id "restorff-vertigo"):
//   params0.xy = u_center   (0..1 frame fractions, top-left origin)
//   params0.z  = u_radius   (subject radius, fraction of the frame's short side)
//   params0.w  = u_strength (0..1; background magnification S = 1 + 2 * strength)
//   params1.x  = u_feather  (width of the transition band, fraction of the short side)

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
    params0: vec4f,
    params1: vec4f,
    params2: vec4f,
    params3: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

const MAX_MAGNIFICATION_GAIN: f32 = 2.0;

// Integral from 0 to d of smoothstep(radius, radius + feather, x) dx.
fn smoothstep_integral(d: f32, radius: f32, feather: f32) -> f32 {
    if (d <= radius) {
        return 0.0;
    }
    if (d >= radius + feather) {
        return 0.5 * feather + (d - radius - feather);
    }
    let u = (d - radius) / feather;
    let u3 = u * u * u;
    return feather * (u3 - 0.5 * u3 * u);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let center = clamp(uniforms.params0.xy, vec2f(0.0, 0.0), vec2f(1.0, 1.0));
    let radius = max(uniforms.params0.z, 0.0);
    let strength = clamp(uniforms.params0.w, 0.0, 1.0);
    let feather = max(uniforms.params1.x, 0.0001);
    let magnification = 1.0 + MAX_MAGNIFICATION_GAIN * strength;

    // Work in units of the frame's short side so the subject region is a circle.
    let short_side = max(min(uniforms.resolution.x, uniforms.resolution.y), 1.0);
    let to_units = uniforms.resolution / short_side;
    let delta = (input.tex_coord - center) * to_units;
    let radial_distance = length(delta);

    let warped = radial_distance - (1.0 - 1.0 / magnification) * smoothstep_integral(radial_distance, radius, feather);
    let ratio = select(1.0, warped / radial_distance, radial_distance > 0.000001);
    let sample_uv = center + (delta * ratio) / to_units;

    return textureSampleLevel(input_texture, input_sampler, sample_uv, 0.0);
}
