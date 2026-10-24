//! Registry of every effect shader the pipeline can run.
//!
//! TypeScript effect definitions (`apps/web/src/effects/definitions/*.ts`) resolve to passes
//! `{ shader: "<id>", uniforms: { u_name: number | number[] } }`. Each id below maps to one
//! precompiled WGSL fragment shader plus the list of uniforms it accepts and where each one
//! is packed in the shared uniform buffer (`uniforms.rs`).
//!
//! To add an effect: write `shaders/<name>.wgsl` (copy the `EffectUniforms` struct from an
//! existing Restorff shader), add a `*_SHADER_ID` constant and an entry to [`EFFECT_SHADERS`].
//! The pipeline, the wasm export `applyEffectPasses` and `listEffectShaders` pick it up with
//! no other change. Runbook: `docs/restorff/RUST.md` ("Add an effect").

use crate::types::{EffectShaderSpec, UniformKind, UniformSlot, UniformSpec};

/// Upstream separable gaussian blur (one direction per pass).
pub const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
/// Restorff "Digital Zoom": punch-in toward a focal point with radial smear and chromatic edge.
pub const DIGITAL_ZOOM_SHADER_ID: &str = "restorff-digital-zoom";
/// Restorff "Vertigo": dolly-zoom illusion (centre region keeps its size, surroundings magnify).
pub const VERTIGO_SHADER_ID: &str = "restorff-vertigo";
/// Restorff "Glass Type": frosted-glass rounded panel (blur, lift, tint, soft border).
pub const GLASS_PANEL_SHADER_ID: &str = "restorff-glass-panel";
/// Restorff "Grade": one-pass colour grade (exposure, white balance, lift/gamma/gain, contrast,
/// saturation, split toning, vignette, grain, amount). Looks = presets in timeline-ops `grades.ts`.
pub const GRADE_SHADER_ID: &str = "restorff-grade";

const fn uniform(
    name: &'static str,
    kind: UniformKind,
    slot: UniformSlot,
    default: Option<&'static [f32]>,
) -> UniformSpec {
    UniformSpec {
        name,
        kind,
        slot,
        default,
    }
}

const GAUSSIAN_BLUR_UNIFORMS: &[UniformSpec] = &[
    uniform("u_sigma", UniformKind::Number, UniformSlot::Scalar(0), None),
    uniform("u_step", UniformKind::Number, UniformSlot::Scalar(1), None),
    uniform("u_direction", UniformKind::Vec2, UniformSlot::Direction, None),
];

const DIGITAL_ZOOM_UNIFORMS: &[UniformSpec] = &[
    uniform("u_focal", UniformKind::Vec2, UniformSlot::Param(0), Some(&[0.5, 0.5])),
    uniform("u_zoom", UniformKind::Number, UniformSlot::Param(2), Some(&[1.0])),
    uniform("u_blur", UniformKind::Number, UniformSlot::Param(3), Some(&[0.0])),
    uniform("u_chroma", UniformKind::Number, UniformSlot::Param(4), Some(&[0.0])),
];

const VERTIGO_UNIFORMS: &[UniformSpec] = &[
    uniform("u_center", UniformKind::Vec2, UniformSlot::Param(0), Some(&[0.5, 0.5])),
    uniform("u_radius", UniformKind::Number, UniformSlot::Param(2), Some(&[0.25])),
    uniform("u_strength", UniformKind::Number, UniformSlot::Param(3), Some(&[0.0])),
    uniform("u_feather", UniformKind::Number, UniformSlot::Param(4), Some(&[0.15])),
];

const GLASS_PANEL_UNIFORMS: &[UniformSpec] = &[
    uniform("u_rect", UniformKind::Vec4, UniformSlot::Param(0), Some(&[0.1, 0.62, 0.8, 0.22])),
    uniform("u_corner_radius", UniformKind::Number, UniformSlot::Param(4), Some(&[24.0])),
    uniform("u_blur", UniformKind::Number, UniformSlot::Param(5), Some(&[24.0])),
    uniform("u_brightness", UniformKind::Number, UniformSlot::Param(6), Some(&[0.12])),
    uniform("u_border_width", UniformKind::Number, UniformSlot::Param(7), Some(&[1.5])),
    uniform("u_tint", UniformKind::Vec4, UniformSlot::Param(8), Some(&[1.0, 1.0, 1.0, 0.06])),
    uniform("u_border_opacity", UniformKind::Number, UniformSlot::Param(12), Some(&[0.35])),
    uniform("u_softness", UniformKind::Number, UniformSlot::Param(13), Some(&[1.0])),
];

/// Every default is the identity: a grade pass with no uniforms leaves the frame untouched.
const GRADE_UNIFORMS: &[UniformSpec] = &[
    uniform("u_exposure", UniformKind::Number, UniformSlot::Param(0), Some(&[0.0])),
    uniform("u_contrast", UniformKind::Number, UniformSlot::Param(1), Some(&[0.0])),
    uniform("u_saturation", UniformKind::Number, UniformSlot::Param(2), Some(&[1.0])),
    uniform("u_temperature", UniformKind::Number, UniformSlot::Param(3), Some(&[0.0])),
    uniform("u_tint", UniformKind::Number, UniformSlot::Param(4), Some(&[0.0])),
    uniform("u_lift", UniformKind::Number, UniformSlot::Param(5), Some(&[0.0])),
    uniform("u_gamma", UniformKind::Number, UniformSlot::Param(6), Some(&[1.0])),
    uniform("u_gain", UniformKind::Number, UniformSlot::Param(7), Some(&[1.0])),
    uniform("u_vignette", UniformKind::Number, UniformSlot::Param(8), Some(&[0.0])),
    uniform("u_grain", UniformKind::Number, UniformSlot::Param(9), Some(&[0.0])),
    uniform("u_grain_seed", UniformKind::Number, UniformSlot::Param(10), Some(&[0.0])),
    uniform("u_amount", UniformKind::Number, UniformSlot::Param(11), Some(&[1.0])),
    uniform("u_split", UniformKind::Vec4, UniformSlot::Param(12), Some(&[0.0, 0.0, 0.0, 0.0])),
];

/// Every shader the pipeline compiles at `initializeGpu()`, in creation order.
pub const EFFECT_SHADERS: &[EffectShaderSpec] = &[
    EffectShaderSpec {
        id: GAUSSIAN_BLUR_SHADER_ID,
        source: include_str!("shaders/gaussian_blur.wgsl"),
        uniforms: GAUSSIAN_BLUR_UNIFORMS,
    },
    EffectShaderSpec {
        id: DIGITAL_ZOOM_SHADER_ID,
        source: include_str!("shaders/digital_zoom.wgsl"),
        uniforms: DIGITAL_ZOOM_UNIFORMS,
    },
    EffectShaderSpec {
        id: VERTIGO_SHADER_ID,
        source: include_str!("shaders/vertigo.wgsl"),
        uniforms: VERTIGO_UNIFORMS,
    },
    EffectShaderSpec {
        id: GLASS_PANEL_SHADER_ID,
        source: include_str!("shaders/glass_panel.wgsl"),
        uniforms: GLASS_PANEL_UNIFORMS,
    },
    EffectShaderSpec {
        id: GRADE_SHADER_ID,
        source: include_str!("shaders/grade.wgsl"),
        uniforms: GRADE_UNIFORMS,
    },
];

pub fn find_effect_shader(id: &str) -> Option<&'static EffectShaderSpec> {
    EFFECT_SHADERS.iter().find(|spec| spec.id == id)
}
