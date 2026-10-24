//! Transitions: two-input fragment shaders that mix the outgoing frame (`from`) into the
//! incoming frame (`to`) by `progress` (0 = all `from`, 1 = all `to`).
//!
//! The compositor renders each side of a cut into its own texture (the scene below plus
//! that side's layers, so the result is opaque), runs one transition pass over the pair and
//! uses the output as the new scene (`compositor.rs`, `FrameItemDescriptor::Transition`).
//! TypeScript sends `{ type: "transition", shader, progress, uniforms, from: [layers],
//! to: [layers] }` (apps/web/src/services/renderer/compositor/frame-descriptor.ts).
//!
//! Shader contract (`shaders/transitions/*.wgsl`): group 0 = `from` texture + sampler,
//! group 1 = `to` texture + sampler, group 2 = [`TransitionUniformBuffer`] (48 bytes);
//! `fragment_main`; only `textureSampleLevel`. progress 0 must return `from` exactly and
//! progress 1 must return `to` exactly (tests/gpu_render.rs checks every shader).
//!
//! To add one: write the WGSL (copy `dissolve.wgsl`), add an entry to
//! [`TRANSITION_SHADERS`] (uniforms in `UniformSlot::Param(0..8)`), add its id to the TS
//! registry (`apps/web/src/transitions/definitions.ts`). Runbook: `docs/restorff/RUST.md`.

use std::collections::{HashMap, HashSet};

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use wgpu::util::DeviceExt;

use crate::types::{UniformKind, UniformSlot, UniformSpec, UniformValue};
use crate::EffectsError;

/// Floats available to a transition in `params0..params1`.
pub const TRANSITION_PARAM_FLOATS: usize = 8;

pub const DISSOLVE_TRANSITION_ID: &str = "restorff-transition-dissolve";
pub const DIP_TRANSITION_ID: &str = "restorff-transition-dip";
pub const FLASH_TRANSITION_ID: &str = "restorff-transition-flash";
pub const WHIP_TRANSITION_ID: &str = "restorff-transition-whip";
pub const SLIDE_TRANSITION_ID: &str = "restorff-transition-slide";
pub const ZOOM_TRANSITION_ID: &str = "restorff-transition-zoom";
pub const WIPE_TRANSITION_ID: &str = "restorff-transition-wipe";
pub const IRIS_TRANSITION_ID: &str = "restorff-transition-iris";
pub const GLITCH_TRANSITION_ID: &str = "restorff-transition-glitch";
pub const BLUR_TRANSITION_ID: &str = "restorff-transition-blur";

/// A transition shader, keyed by the id TypeScript sends.
#[derive(Clone, Copy, Debug)]
pub struct TransitionShaderSpec {
    pub id: &'static str,
    pub source: &'static str,
    /// Uniforms in `UniformSlot::Param(i)` slots, `i < TRANSITION_PARAM_FLOATS`; all have defaults.
    pub uniforms: &'static [UniformSpec],
}

const fn param(name: &'static str, kind: UniformKind, index: usize, default: &'static [f32]) -> UniformSpec {
    UniformSpec {
        name,
        kind,
        slot: UniformSlot::Param(index),
        default: Some(default),
    }
}

const NO_UNIFORMS: &[UniformSpec] = &[];
const DIP_UNIFORMS: &[UniformSpec] = &[param("u_color", UniformKind::Vec4, 0, &[0.0, 0.0, 0.0, 1.0])];
const FLASH_UNIFORMS: &[UniformSpec] = &[param("u_intensity", UniformKind::Number, 0, &[1.0])];
const WHIP_UNIFORMS: &[UniformSpec] = &[
    param("u_direction", UniformKind::Vec2, 0, &[-1.0, 0.0]),
    param("u_blur", UniformKind::Number, 2, &[0.35]),
];
const SLIDE_UNIFORMS: &[UniformSpec] = &[param("u_direction", UniformKind::Vec2, 0, &[-1.0, 0.0])];
const ZOOM_UNIFORMS: &[UniformSpec] = &[
    param("u_center", UniformKind::Vec2, 0, &[0.5, 0.5]),
    param("u_strength", UniformKind::Number, 2, &[1.0]),
    param("u_blur", UniformKind::Number, 3, &[0.6]),
];
const WIPE_UNIFORMS: &[UniformSpec] = &[
    param("u_direction", UniformKind::Vec2, 0, &[1.0, 0.0]),
    param("u_softness", UniformKind::Number, 2, &[0.06]),
];
const IRIS_UNIFORMS: &[UniformSpec] = &[
    param("u_center", UniformKind::Vec2, 0, &[0.5, 0.5]),
    param("u_feather", UniformKind::Number, 2, &[0.04]),
];
const GLITCH_UNIFORMS: &[UniformSpec] = &[param("u_strength", UniformKind::Number, 0, &[1.0])];
const BLUR_UNIFORMS: &[UniformSpec] = &[param("u_strength", UniformKind::Number, 0, &[0.04])];

/// Every transition shader the pipeline compiles at `initializeGpu()`.
pub const TRANSITION_SHADERS: &[TransitionShaderSpec] = &[
    TransitionShaderSpec {
        id: DISSOLVE_TRANSITION_ID,
        source: include_str!("shaders/transitions/dissolve.wgsl"),
        uniforms: NO_UNIFORMS,
    },
    TransitionShaderSpec {
        id: DIP_TRANSITION_ID,
        source: include_str!("shaders/transitions/dip.wgsl"),
        uniforms: DIP_UNIFORMS,
    },
    TransitionShaderSpec {
        id: FLASH_TRANSITION_ID,
        source: include_str!("shaders/transitions/flash.wgsl"),
        uniforms: FLASH_UNIFORMS,
    },
    TransitionShaderSpec {
        id: WHIP_TRANSITION_ID,
        source: include_str!("shaders/transitions/whip.wgsl"),
        uniforms: WHIP_UNIFORMS,
    },
    TransitionShaderSpec {
        id: SLIDE_TRANSITION_ID,
        source: include_str!("shaders/transitions/slide.wgsl"),
        uniforms: SLIDE_UNIFORMS,
    },
    TransitionShaderSpec {
        id: ZOOM_TRANSITION_ID,
        source: include_str!("shaders/transitions/zoom.wgsl"),
        uniforms: ZOOM_UNIFORMS,
    },
    TransitionShaderSpec {
        id: WIPE_TRANSITION_ID,
        source: include_str!("shaders/transitions/wipe.wgsl"),
        uniforms: WIPE_UNIFORMS,
    },
    TransitionShaderSpec {
        id: IRIS_TRANSITION_ID,
        source: include_str!("shaders/transitions/iris.wgsl"),
        uniforms: IRIS_UNIFORMS,
    },
    TransitionShaderSpec {
        id: GLITCH_TRANSITION_ID,
        source: include_str!("shaders/transitions/glitch.wgsl"),
        uniforms: GLITCH_UNIFORMS,
    },
    TransitionShaderSpec {
        id: BLUR_TRANSITION_ID,
        source: include_str!("shaders/transitions/blur.wgsl"),
        uniforms: BLUR_UNIFORMS,
    },
];

pub fn find_transition_shader(id: &str) -> Option<&'static TransitionShaderSpec> {
    TRANSITION_SHADERS.iter().find(|spec| spec.id == id)
}

/// WGSL `TransitionUniforms`: resolution (0..8), progress (8), padding (12), params0 (16..32),
/// params1 (32..48).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct TransitionUniformBuffer {
    pub resolution: [f32; 2],
    pub progress: f32,
    pub padding: f32,
    pub params: [[f32; 4]; 2],
}

impl TransitionUniformBuffer {
    pub fn params_flat(&self) -> &[f32; TRANSITION_PARAM_FLOATS] {
        bytemuck::cast_ref(&self.params)
    }

    fn params_flat_mut(&mut self) -> &mut [f32; TRANSITION_PARAM_FLOATS] {
        bytemuck::cast_mut(&mut self.params)
    }
}

/// Packs a transition pass. Progress is clamped to 0..1 (a NaN becomes 0).
pub fn pack_transition_uniforms(
    spec: &TransitionShaderSpec,
    progress: f32,
    uniforms: &HashMap<String, UniformValue>,
    width: u32,
    height: u32,
) -> Result<TransitionUniformBuffer, EffectsError> {
    let mut buffer = TransitionUniformBuffer {
        resolution: [width as f32, height as f32],
        progress: if progress.is_nan() { 0.0 } else { progress.clamp(0.0, 1.0) },
        ..TransitionUniformBuffer::default()
    };
    for uniform in spec.uniforms {
        let count = uniform.kind.component_count();
        let mut values = [0.0_f32; 4];
        match uniforms.get(uniform.name) {
            None => {
                let default = uniform.default.unwrap_or(&[]);
                for (target, source) in values.iter_mut().zip(default.iter().take(count)) {
                    *target = *source;
                }
            }
            Some(UniformValue::Number(number)) if uniform.kind == UniformKind::Number => values[0] = *number,
            Some(UniformValue::Number(_)) => {
                return Err(EffectsError::InvalidVectorUniform {
                    shader: spec.id.to_string(),
                    uniform: uniform.name.to_string(),
                    expected_length: count,
                });
            }
            Some(UniformValue::Vector(vector)) if uniform.kind != UniformKind::Number && vector.len() == count => {
                values[..count].copy_from_slice(vector);
            }
            Some(UniformValue::Vector(_)) if uniform.kind == UniformKind::Number => {
                return Err(EffectsError::InvalidNumberUniform {
                    shader: spec.id.to_string(),
                    uniform: uniform.name.to_string(),
                });
            }
            Some(UniformValue::Vector(_)) => {
                return Err(EffectsError::InvalidVectorUniform {
                    shader: spec.id.to_string(),
                    uniform: uniform.name.to_string(),
                    expected_length: count,
                });
            }
        }
        let UniformSlot::Param(index) = uniform.slot else {
            return Err(EffectsError::UnsupportedUniform {
                shader: spec.id.to_string(),
                uniform: uniform.name.to_string(),
            });
        };
        let target = &mut buffer.params_flat_mut()[index..index + count];
        target.copy_from_slice(&values[..count]);
    }
    for name in uniforms.keys() {
        if !spec.uniforms.iter().any(|uniform| uniform.name == name) {
            return Err(EffectsError::UnsupportedUniform {
                shader: spec.id.to_string(),
                uniform: name.clone(),
            });
        }
    }
    Ok(buffer)
}

/// Registry self-check: unique ids, `fragment_main`, `u_` names, defaults of the right
/// length, Param slots in range, no overlaps, no vector straddling a vec4.
pub fn validate_transition_shader_specs(specs: &[TransitionShaderSpec]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for spec in specs {
        if spec.id.is_empty() || !ids.insert(spec.id) {
            return Err(format!("transition id '{}' is empty or duplicated", spec.id));
        }
        if !spec.source.contains("fn fragment_main") {
            return Err(format!("transition '{}' has no fragment_main", spec.id));
        }
        let mut names = HashSet::new();
        let mut occupied = HashSet::new();
        for uniform in spec.uniforms {
            let context = format!("transition '{}' uniform '{}'", spec.id, uniform.name);
            if !uniform.name.starts_with("u_") || !names.insert(uniform.name) {
                return Err(format!("{context}: name must start with u_ and be unique"));
            }
            let count = uniform.kind.component_count();
            match uniform.default {
                Some(default) if default.len() == count => {}
                _ => return Err(format!("{context}: needs a default of {count} values")),
            }
            let UniformSlot::Param(index) = uniform.slot else {
                return Err(format!("{context}: transitions only use Param slots"));
            };
            if index + count > TRANSITION_PARAM_FLOATS || (index % 4) + count > 4 {
                return Err(format!("{context}: slot out of range or straddles a vec4"));
            }
            for float in index..index + count {
                if !occupied.insert(float) {
                    return Err(format!("{context}: overlaps another uniform at float {float}"));
                }
            }
        }
    }
    Ok(())
}

pub struct ApplyTransitionOptions<'a> {
    pub from: &'a wgpu::Texture,
    pub to: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub shader: &'a str,
    pub progress: f32,
    pub uniforms: &'a HashMap<String, UniformValue>,
}

pub struct TransitionPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::RenderPipeline>,
}

impl TransitionPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("transitions-uniform-bind-group-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let vertex_shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("transitions-fullscreen-shader"),
            source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("transitions-pipeline-layout"),
            bind_group_layouts: &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.texture_sampler_bind_group_layout()),
                Some(&uniform_bind_group_layout),
            ],
            immediate_size: 0,
        });
        let pipelines = TRANSITION_SHADERS
            .iter()
            .map(|spec| {
                let label = format!("transitions-{}", spec.id);
                let fragment = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(&label),
                    source: wgpu::ShaderSource::Wgsl(spec.source.into()),
                });
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(&label),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &vertex_shader_module,
                        entry_point: Some("vertex_main"),
                        buffers: &[wgpu::VertexBufferLayout {
                            array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &[wgpu::VertexAttribute {
                                format: wgpu::VertexFormat::Float32x2,
                                offset: 0,
                                shader_location: 0,
                            }],
                        }],
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &fragment,
                        entry_point: Some("fragment_main"),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: context.texture_format(),
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                    }),
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    multiview_mask: None,
                    cache: None,
                });
                (spec.id, pipeline)
            })
            .collect();
        Self {
            uniform_bind_group_layout,
            pipelines,
        }
    }

    pub fn has_shader(&self, shader: &str) -> bool {
        self.pipelines.contains_key(shader)
    }

    /// Records one transition pass into `encoder`; returns the mixed frame.
    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        options: ApplyTransitionOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let unknown = || EffectsError::UnknownEffectShader {
            shader: options.shader.to_string(),
        };
        let spec = find_transition_shader(options.shader).ok_or_else(unknown)?;
        let pipeline = self.pipelines.get(spec.id).ok_or_else(unknown)?;
        let uniforms =
            pack_transition_uniforms(spec, options.progress, options.uniforms, options.width, options.height)?;

        let device = context.device();
        let output = context.create_render_texture(options.width, options.height, "transitions-output");
        let output_view = output.create_view(&wgpu::TextureViewDescriptor::default());
        let texture_bind_group = |texture: &wgpu::Texture, label: &str| {
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout: context.texture_sampler_bind_group_layout(),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                    },
                ],
            })
        };
        let from_bind_group = texture_bind_group(options.from, "transitions-from-bind-group");
        let to_bind_group = texture_bind_group(options.to, "transitions-to-bind-group");
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("transitions-uniform-buffer"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("transitions-uniform-bind-group"),
            layout: &self.uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });
        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("transitions-render-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });
            render_pass.set_pipeline(pipeline);
            render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
            render_pass.set_bind_group(0, &from_bind_group, &[]);
            render_pass.set_bind_group(1, &to_bind_group, &[]);
            render_pass.set_bind_group(2, &uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }
        Ok(output)
    }

    /// [`Self::apply_with_encoder`] with its own encoder, submitted immediately (tests, previews).
    pub fn apply(&self, context: &GpuContext, options: ApplyTransitionOptions<'_>) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder = context.device().create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("transitions-command-encoder"),
        });
        let output = self.apply_with_encoder(context, &mut encoder, options)?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use std::mem::{offset_of, size_of};

    use super::*;

    fn uniforms(entries: &[(&str, UniformValue)]) -> HashMap<String, UniformValue> {
        entries.iter().map(|(name, value)| (name.to_string(), value.clone())).collect()
    }

    #[test]
    fn uniform_buffer_layout_matches_wgsl_struct() {
        assert_eq!(size_of::<TransitionUniformBuffer>(), 48);
        assert_eq!(offset_of!(TransitionUniformBuffer, resolution), 0);
        assert_eq!(offset_of!(TransitionUniformBuffer, progress), 8);
        assert_eq!(offset_of!(TransitionUniformBuffer, params), 16);
    }

    #[test]
    fn registry_is_consistent() {
        validate_transition_shader_specs(TRANSITION_SHADERS).unwrap();
        assert_eq!(TRANSITION_SHADERS.len(), 10);
        assert!(TRANSITION_SHADERS.iter().all(|spec| spec.id.starts_with("restorff-transition-")));
        assert!(find_transition_shader("restorff-transition-nope").is_none());
    }

    #[test]
    fn packs_defaults_progress_and_values() {
        let whip = find_transition_shader(WHIP_TRANSITION_ID).unwrap();
        let packed = pack_transition_uniforms(whip, 0.25, &HashMap::new(), 1080, 1920).unwrap();
        assert_eq!(packed.resolution, [1080.0, 1920.0]);
        assert_eq!(packed.progress, 0.25);
        assert_eq!(packed.params[0], [-1.0, 0.0, 0.35, 0.0]);

        let packed = pack_transition_uniforms(
            whip,
            2.0,
            &uniforms(&[("u_direction", UniformValue::Vector(vec![0.0, 1.0])), ("u_blur", UniformValue::Number(0.0))]),
            64,
            64,
        )
        .unwrap();
        assert_eq!(packed.progress, 1.0, "progress is clamped");
        assert_eq!(packed.params[0], [0.0, 1.0, 0.0, 0.0]);

        let dip = find_transition_shader(DIP_TRANSITION_ID).unwrap();
        let packed = pack_transition_uniforms(
            dip,
            f32::NAN,
            &uniforms(&[("u_color", UniformValue::Vector(vec![1.0, 1.0, 1.0, 1.0]))]),
            8,
            8,
        )
        .unwrap();
        assert_eq!(packed.progress, 0.0, "NaN progress becomes 0");
        assert_eq!(packed.params[0], [1.0, 1.0, 1.0, 1.0]);
        assert_eq!(packed.params_flat()[4], 0.0);
    }

    #[test]
    fn rejects_wrong_shapes_and_unknown_uniforms() {
        let whip = find_transition_shader(WHIP_TRANSITION_ID).unwrap();
        assert!(matches!(
            pack_transition_uniforms(whip, 0.5, &uniforms(&[("u_direction", UniformValue::Number(1.0))]), 8, 8),
            Err(EffectsError::InvalidVectorUniform { expected_length: 2, .. })
        ));
        assert!(matches!(
            pack_transition_uniforms(whip, 0.5, &uniforms(&[("u_blur", UniformValue::Vector(vec![1.0, 2.0]))]), 8, 8),
            Err(EffectsError::InvalidNumberUniform { .. })
        ));
        assert!(matches!(
            pack_transition_uniforms(whip, 0.5, &uniforms(&[("u_sigma", UniformValue::Number(1.0))]), 8, 8),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }

    #[test]
    fn validator_catches_bad_specs() {
        const OVERLAP: &[UniformSpec] = &[
            UniformSpec { name: "u_a", kind: UniformKind::Vec2, slot: UniformSlot::Param(0), default: Some(&[0.0, 0.0]) },
            UniformSpec { name: "u_b", kind: UniformKind::Number, slot: UniformSlot::Param(1), default: Some(&[0.0]) },
        ];
        const OUT_OF_RANGE: &[UniformSpec] =
            &[UniformSpec { name: "u_a", kind: UniformKind::Vec4, slot: UniformSlot::Param(8), default: Some(&[0.0; 4]) }];
        const NO_DEFAULT: &[UniformSpec] =
            &[UniformSpec { name: "u_a", kind: UniformKind::Number, slot: UniformSlot::Param(0), default: None }];
        const WRONG_SLOT: &[UniformSpec] =
            &[UniformSpec { name: "u_a", kind: UniformKind::Vec2, slot: UniformSlot::Direction, default: Some(&[0.0, 0.0]) }];
        for uniforms in [OVERLAP, OUT_OF_RANGE, NO_DEFAULT, WRONG_SLOT] {
            let spec = TransitionShaderSpec { id: "t", source: "fn fragment_main", uniforms };
            assert!(validate_transition_shader_specs(&[spec]).is_err());
        }
    }
}
