// RestorffCut "Digital Zoom": punch in toward a focal point, with an optional radial
// motion smear and a chromatic split that grows toward the frame edge.
//
// Uniform packing (see `shaders.rs`, shader id "restorff-digital-zoom"):
//   params0.xy = u_focal  (focal point, 0..1 frame fractions, top-left origin)
//   params0.z  = u_zoom   (scale factor, >= 1; 1 = no zoom)
//   params0.w  = u_blur   (0..1, radial smear length as a fraction of the distance to the focal point)
//   params1.x  = u_chroma (0..1, red/blue split strength; 0 = none)

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

const SMEAR_SAMPLES: i32 = 16;
// Longest smear (u_blur = 1) reaches this far back toward the focal point.
const MAX_SMEAR: f32 = 0.25;
// Largest red/blue scale offset (u_chroma = 1).
const MAX_CHROMA: f32 = 0.03;

fn sample_split(focal: vec2f, offset: vec2f, chroma: f32) -> vec4f {
    let red = textureSampleLevel(input_texture, input_sampler, focal + offset * (1.0 + chroma), 0.0);
    let green = textureSampleLevel(input_texture, input_sampler, focal + offset, 0.0);
    let blue = textureSampleLevel(input_texture, input_sampler, focal + offset * (1.0 - chroma), 0.0);
    return vec4f(red.r, green.g, blue.b, green.a);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let focal = clamp(uniforms.params0.xy, vec2f(0.0, 0.0), vec2f(1.0, 1.0));
    let zoom = max(uniforms.params0.z, 1.0);
    let smear = clamp(uniforms.params0.w, 0.0, 1.0) * MAX_SMEAR;
    let chroma = clamp(uniforms.params1.x, 0.0, 1.0) * MAX_CHROMA;

    // The focal point stays fixed; everything else is pushed away from it. Because
    // focal is inside [0, 1] and zoom >= 1, the sampled point never leaves the frame.
    let offset = (input.tex_coord - focal) / zoom;

    // Without smear one tap per channel is enough (3 texture reads instead of 48).
    let samples = select(SMEAR_SAMPLES, 1, smear <= 0.0);
    let last = f32(max(samples - 1, 1));
    var color = vec4f(0.0, 0.0, 0.0, 0.0);
    for (var index = 0; index < samples; index = index + 1) {
        let t = f32(index) / last;
        color = color + sample_split(focal, offset * (1.0 - smear * t), chroma);
    }
    return color / f32(samples);
}
