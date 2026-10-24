// RestorffCut "Grade": one-pass colour grade. Every control is a plain number, so every
// control is keyframable from TypeScript (effects.<id>.params.<key>); the named looks
// (warm morning, moody, clean, film, cool night, punchy, ...) are presets of these numbers
// in packages/timeline-ops/src/grades.ts.
//
// Input and output are straight-alpha, sRGB-encoded colour in an Unorm texture (the
// compositor's convention). Order of operations:
//   1. white balance (temperature, tint) and exposure, in LINEAR light, luminance-preserving gains
//   2. lift / gamma / gain (shadows / midtones / highlights), display space
//   3. contrast: an S-curve around mid grey that keeps 0 at 0 and 1 at 1 (never clips)
//   4. saturation around Rec.709 luma
//   5. split toning: a hue pushed into the shadows and another into the highlights
//   6. vignette (darken or lighten the edges; follows the frame shape)
//   7. film grain: monochrome, strongest in the midtones, a new pattern per seed (TS passes time)
//   8. amount: mix between the untouched pixel and the graded one (the look's strength)
// With every control at its default the output equals the input (the render test checks it).
//
// Uniform packing (see `shaders.rs`, shader id "restorff-grade"):
//   params0 = u_exposure (stops), u_contrast (-1..1), u_saturation (factor, 1 = unchanged), u_temperature (-1..1)
//   params1 = u_tint (-1..1, + = magenta), u_lift (-0.5..0.5), u_gamma (factor > 0, 1 = unchanged), u_gain (factor)
//   params2 = u_vignette (-1..1, + = darker edges), u_grain (0..1), u_grain_seed (any float), u_amount (0..1)
//   params3 = u_split: shadow hue (turns 0..1), shadow strength (0..1), highlight hue, highlight strength

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

const LUMA: vec3f = vec3f(0.2126, 0.7152, 0.0722);
// Strength scales, chosen so +-1 on a control is a strong but usable move.
const TEMPERATURE_RANGE: f32 = 0.3;
const TINT_RANGE: f32 = 0.25;
const CONTRAST_RANGE: f32 = 1.5;
const SPLIT_RANGE: f32 = 0.3;
const VIGNETTE_DARKEN: f32 = 0.85;
const VIGNETTE_LIGHTEN: f32 = 0.5;
const GRAIN_RANGE: f32 = 0.16;
const GRAIN_CELL_PX: f32 = 2.0;

fn srgb_to_linear(c: vec3f) -> vec3f {
    let low = c / 12.92;
    let high = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
    return select(high, low, c <= vec3f(0.04045));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
    let x = clamp(c, vec3f(0.0), vec3f(1.0));
    let low = x * 12.92;
    let high = 1.055 * pow(x, vec3f(1.0 / 2.4)) - vec3f(0.055);
    return select(high, low, x <= vec3f(0.0031308));
}

// Fully saturated colour for a hue in turns (0 = red, 1/3 = green, 2/3 = blue).
fn hue_rgb(hue: f32) -> vec3f {
    let h = fract(hue);
    let k = abs(fract(vec3f(h, h + 2.0 / 3.0, h + 1.0 / 3.0)) * 6.0 - vec3f(3.0)) - vec3f(1.0);
    return clamp(k, vec3f(0.0), vec3f(1.0));
}

// PCG hash (Jarzynski & Olano 2020): integer only, so it is identical on every GPU.
fn pcg(value: u32) -> u32 {
    let state = value * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn unit_hash(value: u32) -> f32 {
    return f32(pcg(value) >> 8u) / 16777216.0;
}

// A value in -1..1 (triangular distribution) for one grain cell and seed.
fn cell_noise(cell: vec2u, seed: u32) -> f32 {
    let first = unit_hash(cell.x ^ pcg(cell.y ^ seed));
    let second = unit_hash(cell.y ^ pcg(cell.x ^ pcg(seed)));
    return first + second - 1.0;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSampleLevel(input_texture, input_sampler, input.tex_coord, 0.0);

    let exposure = uniforms.params0.x;
    let contrast = clamp(uniforms.params0.y, -1.0, 1.0);
    let saturation = max(uniforms.params0.z, 0.0);
    let temperature = clamp(uniforms.params0.w, -1.0, 1.0);
    let tint = clamp(uniforms.params1.x, -1.0, 1.0);
    let lift = clamp(uniforms.params1.y, -0.5, 0.5);
    let gamma = max(uniforms.params1.z, 0.05);
    let gain = max(uniforms.params1.w, 0.0);
    let vignette = clamp(uniforms.params2.x, -1.0, 1.0);
    let grain = clamp(uniforms.params2.y, 0.0, 1.0);
    let grain_seed = uniforms.params2.z;
    let amount = clamp(uniforms.params2.w, 0.0, 1.0);
    let split = uniforms.params3;

    // 1. white balance + exposure in linear light. The gains are normalised so a neutral
    //    grey keeps its luminance: temperature and tint move colour, not brightness.
    var balance = vec3f(
        1.0 + TEMPERATURE_RANGE * temperature,
        1.0 - TINT_RANGE * tint,
        1.0 - TEMPERATURE_RANGE * temperature,
    );
    balance = balance / dot(balance, LUMA);
    var color = linear_to_srgb(srgb_to_linear(source.rgb) * balance * exp2(exposure));

    // 2. lift raises (or crushes) the blacks with white fixed, gain scales the whites with
    //    black fixed, gamma bends the midtones (> 1 = brighter mids).
    color = gain * (color + lift * (vec3f(1.0) - color));
    color = pow(max(color, vec3f(0.0)), vec3f(1.0 / gamma));
    color = clamp(color, vec3f(0.0), vec3f(1.0));

    // 3. contrast: x^k / (x^k + (1 - x)^k) is identity at k = 1, an S-curve above, flatter below.
    let k = exp2(contrast * CONTRAST_RANGE);
    let rising = pow(color, vec3f(k));
    let falling = pow(vec3f(1.0) - color, vec3f(k));
    color = rising / max(rising + falling, vec3f(0.000001));

    // 4. saturation
    let luma = dot(color, LUMA);
    color = vec3f(luma) + (color - vec3f(luma)) * saturation;

    // 5. split toning: shift chroma only (the hue's own luma is subtracted).
    let shadow_hue = hue_rgb(split.x);
    let highlight_hue = hue_rgb(split.z);
    let shadow_weight = 1.0 - smoothstep(0.0, 0.6, luma);
    let highlight_weight = smoothstep(0.4, 1.0, luma);
    color = color
        + (shadow_hue - vec3f(dot(shadow_hue, LUMA))) * (clamp(split.y, 0.0, 1.0) * shadow_weight * SPLIT_RANGE)
        + (highlight_hue - vec3f(dot(highlight_hue, LUMA))) * (clamp(split.w, 0.0, 1.0) * highlight_weight * SPLIT_RANGE);
    color = clamp(color, vec3f(0.0), vec3f(1.0));

    // 6. vignette: 0 at the centre, 1 in the corners, following the frame's shape.
    let edge = length((input.tex_coord - vec2f(0.5)) * 2.0) * 0.70710678;
    let falloff = smoothstep(0.35, 1.0, edge);
    let darken = max(vignette, 0.0) * falloff * VIGNETTE_DARKEN;
    let lighten = max(-vignette, 0.0) * falloff * VIGNETTE_LIGHTEN;
    color = color * (1.0 - darken);
    color = color + (vec3f(1.0) - color) * lighten;

    // 7. grain: smooth value noise over GRAIN_CELL_PX-wide cells (at a 1080 px short side,
    //    scaled with the render), new for every seed; strongest in the midtones. Soft 2 px
    //    clumps, not 1 px salt: single-pixel noise does not survive H.264 at delivery
    //    bitrates (MEASURED 2026-10-20: a 1 px grain of std ~12 levels came out of the
    //    editor's export at std ~3 with sparse speckles).
    let short_side = max(min(uniforms.resolution.x, uniforms.resolution.y), 1.0);
    let cell_size = GRAIN_CELL_PX * max(1.0, short_side / 1080.0);
    let grain_position = max(input.tex_coord * uniforms.resolution / cell_size, vec2f(0.0));
    let base_cell = vec2u(floor(grain_position));
    let within = fract(grain_position);
    let blend = within * within * (vec2f(3.0) - 2.0 * within);
    let seed = pcg(bitcast<u32>(grain_seed));
    let n00 = cell_noise(base_cell, seed);
    let n10 = cell_noise(base_cell + vec2u(1u, 0u), seed);
    let n01 = cell_noise(base_cell + vec2u(0u, 1u), seed);
    let n11 = cell_noise(base_cell + vec2u(1u, 1u), seed);
    let noise = mix(mix(n00, n10, blend.x), mix(n01, n11, blend.x), blend.y);
    let graded_luma = dot(color, LUMA);
    let midtone = 0.35 + 0.65 * (4.0 * graded_luma * (1.0 - graded_luma));
    color = color + vec3f(noise * grain * GRAIN_RANGE * midtone);

    // 8. amount
    color = mix(source.rgb, clamp(color, vec3f(0.0), vec3f(1.0)), amount);
    return vec4f(color, source.a);
}
