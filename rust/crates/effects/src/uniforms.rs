//! Packs an [`EffectPass`]'s uniforms into the one uniform buffer every effect shader binds.
//!
//! Layout (std140-compatible, 96 bytes; WGSL `EffectUniforms` in `shaders/*.wgsl`):
//!
//! | bytes  | field        | WGSL              | used by                       |
//! |--------|--------------|-------------------|-------------------------------|
//! | 0..8   | `resolution` | `vec2f`           | all (set from width, height)  |
//! | 8..16  | `direction`  | `vec2f`           | gaussian-blur `u_direction`   |
//! | 16..32 | `scalars`    | `vec4f`           | gaussian-blur `u_sigma/u_step`|
//! | 32..96 | `params`     | `params0..params3`| Restorff effects (16 floats)  |
//!
//! The first 32 bytes are exactly the upstream layout, so `gaussian_blur.wgsl` (which only
//! declares those 32 bytes) is unchanged. Nothing here touches the GPU, so it is unit-tested
//! on the host.

use std::collections::HashSet;

use bytemuck::{Pod, Zeroable};

use crate::shaders::EFFECT_SHADERS;
use crate::types::{EffectShaderSpec, UniformKind, UniformSlot, UniformSpec};
use crate::{EffectPass, EffectsError, UniformValue};

/// Floats available to Restorff effects in `params0..params3`.
pub const EFFECT_PARAM_FLOATS: usize = 16;
/// Floats in the legacy `scalars` vec4.
pub const EFFECT_SCALAR_FLOATS: usize = 4;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct EffectUniformBuffer {
    pub resolution: [f32; 2],
    pub direction: [f32; 2],
    pub scalars: [f32; 4],
    pub params: [[f32; 4]; 4],
}

impl EffectUniformBuffer {
    /// Flat view of `params` (float `i` = `params[i / 4][i % 4]`).
    pub fn params_flat(&self) -> &[f32; EFFECT_PARAM_FLOATS] {
        bytemuck::cast_ref(&self.params)
    }

    fn params_flat_mut(&mut self) -> &mut [f32; EFFECT_PARAM_FLOATS] {
        bytemuck::cast_mut(&mut self.params)
    }
}

pub fn pack_effect_uniforms(
    spec: &EffectShaderSpec,
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let mut buffer = EffectUniformBuffer {
        resolution: [width as f32, height as f32],
        ..EffectUniformBuffer::default()
    };

    for uniform in spec.uniforms {
        let values = read_uniform(pass, uniform)?;
        write_slot(&mut buffer, uniform, &values);
    }

    for name in pass.uniforms.keys() {
        if !spec.uniforms.iter().any(|uniform| uniform.name == name) {
            return Err(EffectsError::UnsupportedUniform {
                shader: pass.shader.clone(),
                uniform: name.clone(),
            });
        }
    }

    Ok(buffer)
}

fn read_uniform(pass: &EffectPass, uniform: &UniformSpec) -> Result<[f32; 4], EffectsError> {
    let count = uniform.kind.component_count();
    let mut values = [0.0; 4];

    let Some(value) = pass.uniforms.get(uniform.name) else {
        let Some(default) = uniform.default else {
            return Err(EffectsError::MissingUniform {
                shader: pass.shader.clone(),
                uniform: uniform.name.to_string(),
            });
        };
        for (target, source) in values.iter_mut().zip(default.iter().take(count)) {
            *target = *source;
        }
        return Ok(values);
    };

    match (uniform.kind, value) {
        (UniformKind::Number, UniformValue::Number(number)) => {
            values[0] = *number;
            Ok(values)
        }
        (UniformKind::Number, UniformValue::Vector(_)) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.name.to_string(),
        }),
        (_, UniformValue::Vector(vector)) if vector.len() == count => {
            values[..count].copy_from_slice(vector);
            Ok(values)
        }
        _ => Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.name.to_string(),
            expected_length: count,
        }),
    }
}

fn write_slot(buffer: &mut EffectUniformBuffer, uniform: &UniformSpec, values: &[f32; 4]) {
    let count = uniform.kind.component_count();
    let target: &mut [f32] = match uniform.slot {
        UniformSlot::Direction => &mut buffer.direction,
        UniformSlot::Scalar(index) => &mut buffer.scalars[index..],
        UniformSlot::Param(index) => &mut buffer.params_flat_mut()[index..],
    };
    for (slot, value) in target.iter_mut().zip(values.iter().take(count)) {
        *slot = *value;
    }
}

/// First float index a slot occupies in the whole buffer (resolution = 0..2).
fn absolute_float_index(slot: UniformSlot) -> usize {
    match slot {
        UniformSlot::Direction => 2,
        UniformSlot::Scalar(index) => 4 + index,
        UniformSlot::Param(index) => 8 + index,
    }
}

/// Checks the registry is self-consistent: unique ids and names, `u_` prefixes, defaults
/// of the right length, slots in range, no two uniforms sharing a float, and no vector
/// straddling a vec4 boundary (shaders read whole `paramsN` components).
pub fn validate_effect_shader_specs(specs: &[EffectShaderSpec]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for spec in specs {
        if spec.id.is_empty() || !ids.insert(spec.id) {
            return Err(format!("shader id '{}' is empty or duplicated", spec.id));
        }
        if !spec.source.contains("fn fragment_main") {
            return Err(format!("shader '{}' has no fragment_main", spec.id));
        }

        let mut names = HashSet::new();
        let mut occupied = HashSet::new();
        for uniform in spec.uniforms {
            let context = format!("shader '{}' uniform '{}'", spec.id, uniform.name);
            if !uniform.name.starts_with("u_") || !names.insert(uniform.name) {
                return Err(format!("{context}: name must start with u_ and be unique"));
            }
            let count = uniform.kind.component_count();
            if let Some(default) = uniform.default {
                if default.len() != count {
                    return Err(format!("{context}: default has {} values, expected {count}", default.len()));
                }
            }
            let (offset, capacity) = match uniform.slot {
                UniformSlot::Direction => {
                    if uniform.kind != UniformKind::Vec2 {
                        return Err(format!("{context}: the direction slot holds a vec2"));
                    }
                    (0, 2)
                }
                UniformSlot::Scalar(index) => (index, EFFECT_SCALAR_FLOATS),
                UniformSlot::Param(index) => (index, EFFECT_PARAM_FLOATS),
            };
            if offset + count > capacity {
                return Err(format!("{context}: slot out of range"));
            }
            if (offset % 4) + count > 4 {
                return Err(format!("{context}: straddles a vec4 boundary"));
            }
            let start = absolute_float_index(uniform.slot);
            for float in start..start + count {
                if !occupied.insert(float) {
                    return Err(format!("{context}: overlaps another uniform at float {float}"));
                }
            }
        }
    }
    Ok(())
}

/// [`validate_effect_shader_specs`] over the built-in registry.
pub fn validate_builtin_effect_shaders() -> Result<(), String> {
    validate_effect_shader_specs(EFFECT_SHADERS)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::mem::{offset_of, size_of};

    use super::*;
    use crate::shaders::{
        DIGITAL_ZOOM_SHADER_ID, GAUSSIAN_BLUR_SHADER_ID, GLASS_PANEL_SHADER_ID, GRADE_SHADER_ID,
        VERTIGO_SHADER_ID, find_effect_shader,
    };

    fn pass(shader: &str, uniforms: &[(&str, UniformValue)]) -> EffectPass {
        EffectPass {
            shader: shader.to_string(),
            uniforms: uniforms
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect::<HashMap<_, _>>(),
        }
    }

    fn pack(shader: &str, uniforms: &[(&str, UniformValue)]) -> Result<EffectUniformBuffer, EffectsError> {
        let spec = find_effect_shader(shader).expect("shader is registered");
        pack_effect_uniforms(spec, &pass(shader, uniforms), 1920, 1080)
    }

    fn number(value: f32) -> UniformValue {
        UniformValue::Number(value)
    }

    fn vector(values: &[f32]) -> UniformValue {
        UniformValue::Vector(values.to_vec())
    }

    /// The upstream (pre-Restorff) uniform struct, kept here to prove the prefix is unchanged.
    #[repr(C)]
    #[derive(Clone, Copy, Pod, Zeroable)]
    struct UpstreamEffectUniformBuffer {
        resolution: [f32; 2],
        direction: [f32; 2],
        scalars: [f32; 4],
    }

    #[test]
    fn uniform_buffer_layout_matches_wgsl_struct() {
        assert_eq!(size_of::<EffectUniformBuffer>(), 96);
        assert_eq!(offset_of!(EffectUniformBuffer, resolution), 0);
        assert_eq!(offset_of!(EffectUniformBuffer, direction), 8);
        assert_eq!(offset_of!(EffectUniformBuffer, scalars), 16);
        assert_eq!(offset_of!(EffectUniformBuffer, params), 32);
        // Uniform buffers bind in 16-byte multiples.
        assert_eq!(size_of::<EffectUniformBuffer>() % 16, 0);
    }

    #[test]
    fn gaussian_blur_packs_exactly_like_upstream() {
        let packed = pack(
            GAUSSIAN_BLUR_SHADER_ID,
            &[("u_sigma", number(3.5)), ("u_step", number(2.0)), ("u_direction", vector(&[0.0, 1.0]))],
        )
        .unwrap();
        let upstream = UpstreamEffectUniformBuffer {
            resolution: [1920.0, 1080.0],
            direction: [0.0, 1.0],
            scalars: [3.5, 2.0, 0.0, 0.0],
        };
        assert_eq!(&bytemuck::bytes_of(&packed)[..32], bytemuck::bytes_of(&upstream));
        assert_eq!(packed.params, [[0.0; 4]; 4]);
    }

    #[test]
    fn gaussian_blur_keeps_upstream_errors() {
        assert!(matches!(
            pack(GAUSSIAN_BLUR_SHADER_ID, &[("u_step", number(1.0)), ("u_direction", vector(&[1.0, 0.0]))]),
            Err(EffectsError::MissingUniform { uniform, .. }) if uniform == "u_sigma"
        ));
        assert!(matches!(
            pack(
                GAUSSIAN_BLUR_SHADER_ID,
                &[("u_sigma", vector(&[1.0, 2.0])), ("u_step", number(1.0)), ("u_direction", vector(&[1.0, 0.0]))]
            ),
            Err(EffectsError::InvalidNumberUniform { uniform, .. }) if uniform == "u_sigma"
        ));
        assert!(matches!(
            pack(
                GAUSSIAN_BLUR_SHADER_ID,
                &[("u_sigma", number(1.0)), ("u_step", number(1.0)), ("u_direction", vector(&[1.0, 0.0, 0.0]))]
            ),
            Err(EffectsError::InvalidVectorUniform { expected_length: 2, .. })
        ));
        assert!(matches!(
            pack(
                GAUSSIAN_BLUR_SHADER_ID,
                &[
                    ("u_sigma", number(1.0)),
                    ("u_step", number(1.0)),
                    ("u_direction", vector(&[1.0, 0.0])),
                    ("u_extra", number(1.0)),
                ]
            ),
            Err(EffectsError::UnsupportedUniform { uniform, .. }) if uniform == "u_extra"
        ));
    }

    #[test]
    fn digital_zoom_packs_params_and_defaults() {
        let defaults = pack(DIGITAL_ZOOM_SHADER_ID, &[]).unwrap();
        assert_eq!(defaults.resolution, [1920.0, 1080.0]);
        assert_eq!(defaults.params[0], [0.5, 0.5, 1.0, 0.0]);
        assert_eq!(defaults.params[1], [0.0; 4]);

        let packed = pack(
            DIGITAL_ZOOM_SHADER_ID,
            &[
                ("u_focal", vector(&[0.3, 0.7])),
                ("u_zoom", number(2.0)),
                ("u_blur", number(0.5)),
                ("u_chroma", number(0.25)),
            ],
        )
        .unwrap();
        assert_eq!(packed.params[0], [0.3, 0.7, 2.0, 0.5]);
        assert_eq!(packed.params[1], [0.25, 0.0, 0.0, 0.0]);
        assert_eq!(packed.direction, [0.0, 0.0]);
        assert_eq!(packed.scalars, [0.0; 4]);
    }

    #[test]
    fn vertigo_packs_params() {
        let packed = pack(
            VERTIGO_SHADER_ID,
            &[
                ("u_center", vector(&[0.4, 0.45])),
                ("u_radius", number(0.3)),
                ("u_strength", number(0.8)),
                ("u_feather", number(0.05)),
            ],
        )
        .unwrap();
        assert_eq!(packed.params[0], [0.4, 0.45, 0.3, 0.8]);
        assert_eq!(packed.params[1], [0.05, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn glass_panel_packs_params() {
        let packed = pack(
            GLASS_PANEL_SHADER_ID,
            &[
                ("u_rect", vector(&[0.1, 0.2, 0.5, 0.25])),
                ("u_corner_radius", number(18.0)),
                ("u_blur", number(30.0)),
                ("u_brightness", number(0.2)),
                ("u_border_width", number(2.0)),
                ("u_tint", vector(&[0.9, 0.95, 1.0, 0.1])),
                ("u_border_opacity", number(0.5)),
                ("u_softness", number(1.5)),
            ],
        )
        .unwrap();
        assert_eq!(packed.params[0], [0.1, 0.2, 0.5, 0.25]);
        assert_eq!(packed.params[1], [18.0, 30.0, 0.2, 2.0]);
        assert_eq!(packed.params[2], [0.9, 0.95, 1.0, 0.1]);
        assert_eq!(packed.params[3], [0.5, 1.5, 0.0, 0.0]);
        assert_eq!(packed.params_flat()[13], 1.5);
    }

    #[test]
    fn grade_defaults_are_the_identity_and_params_pack_in_order() {
        let defaults = pack(GRADE_SHADER_ID, &[]).unwrap();
        // exposure 0, contrast 0, saturation 1, temperature 0 | tint 0, lift 0, gamma 1, gain 1
        // | vignette 0, grain 0, seed 0, amount 1 | split 0, 0, 0, 0
        assert_eq!(defaults.params[0], [0.0, 0.0, 1.0, 0.0]);
        assert_eq!(defaults.params[1], [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(defaults.params[2], [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(defaults.params[3], [0.0; 4]);

        let packed = pack(
            GRADE_SHADER_ID,
            &[
                ("u_exposure", number(0.5)),
                ("u_contrast", number(-0.25)),
                ("u_saturation", number(0.75)),
                ("u_temperature", number(0.3)),
                ("u_tint", number(-0.1)),
                ("u_lift", number(0.04)),
                ("u_gamma", number(1.2)),
                ("u_gain", number(0.9)),
                ("u_vignette", number(0.35)),
                ("u_grain", number(0.2)),
                ("u_grain_seed", number(12.5)),
                ("u_amount", number(0.8)),
                ("u_split", vector(&[0.55, 0.3, 0.08, 0.2])),
            ],
        )
        .unwrap();
        assert_eq!(packed.params[0], [0.5, -0.25, 0.75, 0.3]);
        assert_eq!(packed.params[1], [-0.1, 0.04, 1.2, 0.9]);
        assert_eq!(packed.params[2], [0.35, 0.2, 12.5, 0.8]);
        assert_eq!(packed.params[3], [0.55, 0.3, 0.08, 0.2]);
        assert_eq!(packed.scalars, [0.0; 4]);
        assert!(matches!(
            pack(GRADE_SHADER_ID, &[("u_split", vector(&[0.5, 0.5]))]),
            Err(EffectsError::InvalidVectorUniform { expected_length: 4, .. })
        ));
    }

    #[test]
    fn restorff_effects_reject_wrong_shapes() {
        assert!(matches!(
            pack(GLASS_PANEL_SHADER_ID, &[("u_rect", vector(&[0.1, 0.2]))]),
            Err(EffectsError::InvalidVectorUniform { expected_length: 4, .. })
        ));
        assert!(matches!(
            pack(VERTIGO_SHADER_ID, &[("u_center", number(0.5))]),
            Err(EffectsError::InvalidVectorUniform { expected_length: 2, .. })
        ));
        assert!(matches!(
            pack(DIGITAL_ZOOM_SHADER_ID, &[("u_sigma", number(1.0))]),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }

    #[test]
    fn builtin_registry_is_consistent() {
        validate_builtin_effect_shaders().unwrap();
        assert_eq!(EFFECT_SHADERS.len(), 5);
        assert!(find_effect_shader("no-such-shader").is_none());
        for spec in EFFECT_SHADERS.iter().filter(|spec| spec.id.starts_with("restorff-")) {
            for uniform in spec.uniforms {
                assert!(uniform.default.is_some(), "{} {} needs a default", spec.id, uniform.name);
                assert!(matches!(uniform.slot, UniformSlot::Param(_)), "{} uses params", spec.id);
            }
        }
    }

    #[test]
    fn validator_catches_bad_specs() {
        const OVERLAP: &[UniformSpec] = &[
            UniformSpec { name: "u_a", kind: UniformKind::Vec2, slot: UniformSlot::Param(0), default: Some(&[0.0, 0.0]) },
            UniformSpec { name: "u_b", kind: UniformKind::Number, slot: UniformSlot::Param(1), default: Some(&[0.0]) },
        ];
        const STRADDLE: &[UniformSpec] = &[UniformSpec {
            name: "u_a",
            kind: UniformKind::Vec2,
            slot: UniformSlot::Param(3),
            default: Some(&[0.0, 0.0]),
        }];
        const BAD_DEFAULT: &[UniformSpec] = &[UniformSpec {
            name: "u_a",
            kind: UniformKind::Vec4,
            slot: UniformSlot::Param(0),
            default: Some(&[0.0]),
        }];
        for uniforms in [OVERLAP, STRADDLE, BAD_DEFAULT] {
            let spec = EffectShaderSpec { id: "test", source: "fn fragment_main", uniforms };
            assert!(validate_effect_shader_specs(&[spec]).is_err());
        }
    }
}
