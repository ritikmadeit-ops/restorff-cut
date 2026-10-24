//! Every registered effect shader must parse, validate and translate to GLSL ES 3.00 for
//! WebGL2 — the backend most browsers hit through `wgpu`'s `webgl` feature. A shader that
//! fails here would make `create_shader_module` panic inside `initializeGpu()`, which takes
//! the whole GPU renderer down (not just the one effect), so this runs on the host first.

use effects::{EFFECT_SHADERS, EffectUniformBuffer, TRANSITION_SHADERS, TransitionUniformBuffer};
use naga::back::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};

fn parse_and_validate(id: &str, source: &str) -> (naga::Module, naga::valid::ModuleInfo) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|error| panic!("{id}: WGSL parse error:\n{}", error.emit_to_string(source)));
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|error| panic!("{id}: validation error:\n{}", error.emit_to_string(source)));
    (module, info)
}

fn uniform_struct_size(module: &naga::Module) -> u32 {
    let (_, ty) = module
        .types
        .iter()
        .find(|(_, ty)| ty.name.as_deref() == Some("EffectUniforms"))
        .expect("shader declares struct EffectUniforms");
    match ty.inner {
        naga::TypeInner::Struct { span, .. } => span,
        _ => panic!("EffectUniforms is not a struct"),
    }
}

#[test]
fn every_effect_shader_validates_and_translates_to_webgl2_glsl() {
    for spec in EFFECT_SHADERS {
        let (module, info) = parse_and_validate(spec.id, spec.source);

        let mut output = String::new();
        let options = glsl::Options {
            version: glsl::Version::Embedded {
                version: 300,
                is_webgl: true,
            },
            ..glsl::Options::default()
        };
        let pipeline_options = glsl::PipelineOptions {
            shader_stage: naga::ShaderStage::Fragment,
            entry_point: "fragment_main".to_string(),
            multiview: None,
        };
        let mut writer = glsl::Writer::new(
            &mut output,
            &module,
            &info,
            &options,
            &pipeline_options,
            naga::proc::BoundsCheckPolicies::default(),
        )
        .unwrap_or_else(|error| panic!("{}: GLSL writer setup failed: {error:?}", spec.id));
        writer
            .write()
            .unwrap_or_else(|error| panic!("{}: GLSL ES 3.00 translation failed: {error:?}", spec.id));
        assert!(output.starts_with("#version 300 es"), "{}: unexpected GLSL header", spec.id);
    }
}

#[test]
fn uniform_struct_fits_the_packed_buffer() {
    let buffer_size = std::mem::size_of::<EffectUniformBuffer>() as u32;
    for spec in EFFECT_SHADERS {
        let (module, _) = parse_and_validate(spec.id, spec.source);
        let size = uniform_struct_size(&module);
        if spec.id.starts_with("restorff-") {
            assert_eq!(size, buffer_size, "{}: EffectUniforms must declare all 96 bytes", spec.id);
        } else {
            // The upstream gaussian blur declares only the first 32 bytes.
            assert!(size <= buffer_size, "{}: struct larger than the buffer", spec.id);
        }
    }
}

#[test]
fn restorff_shaders_bind_like_the_pipeline_layout() {
    for spec in EFFECT_SHADERS {
        let (module, _) = parse_and_validate(spec.id, spec.source);
        let mut bindings = module
            .global_variables
            .iter()
            .filter_map(|(_, variable)| variable.binding.as_ref())
            .map(|binding| (binding.group, binding.binding))
            .collect::<Vec<_>>();
        bindings.sort();
        assert_eq!(bindings, vec![(0, 0), (0, 1), (1, 0)], "{}: bind groups", spec.id);
        assert!(
            module.entry_points.iter().any(|entry| entry.name == "fragment_main"
                && entry.stage == naga::ShaderStage::Fragment),
            "{}: needs @fragment fn fragment_main",
            spec.id
        );
    }
}

/// naga 29 does NOT enforce WGSL uniformity in fragment shaders
/// (`DISABLE_UNIFORMITY_REQ_FOR_FRAGMENT_STAGE = true` in naga/src/valid/analyzer.rs), but a
/// browser's WebGPU compiler (Tint) does: `textureSample` (implicit derivatives) inside a
/// per-pixel branch passes here and then fails in Chrome's WebGPU path. So Restorff shaders
/// use only explicit-level sampling (`textureSampleLevel(.., 0.0)`), which is legal in any
/// control flow, and this test enforces it at the source level.
#[test]
fn restorff_shaders_only_use_explicit_level_sampling() {
    for spec in EFFECT_SHADERS.iter().filter(|spec| spec.id.starts_with("restorff-")) {
        let code: String = spec
            .source
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["textureSample(", "textureSampleBias(", "dpdx", "dpdy", "fwidth"] {
            assert!(!code.contains(forbidden), "{}: uses {forbidden}", spec.id);
        }
        assert!(code.contains("textureSampleLevel("), "{}: samples with textureSampleLevel", spec.id);
    }
}

#[test]
fn fullscreen_vertex_shader_still_validates() {
    parse_and_validate("fullscreen", gpu::FULLSCREEN_SHADER_SOURCE);
}

fn translate_to_webgl2(id: &str, module: &naga::Module, info: &naga::valid::ModuleInfo) -> String {
    let mut output = String::new();
    let options = glsl::Options {
        version: glsl::Version::Embedded {
            version: 300,
            is_webgl: true,
        },
        ..glsl::Options::default()
    };
    let pipeline_options = glsl::PipelineOptions {
        shader_stage: naga::ShaderStage::Fragment,
        entry_point: "fragment_main".to_string(),
        multiview: None,
    };
    let mut writer = glsl::Writer::new(
        &mut output,
        module,
        info,
        &options,
        &pipeline_options,
        naga::proc::BoundsCheckPolicies::default(),
    )
    .unwrap_or_else(|error| panic!("{id}: GLSL writer setup failed: {error:?}"));
    writer
        .write()
        .unwrap_or_else(|error| panic!("{id}: GLSL ES 3.00 translation failed: {error:?}"));
    output
}

/// Transitions go through the same WebGL2 path as effects; one bad shader would take
/// `initializeGpu()` down with it.
#[test]
fn every_transition_shader_validates_and_translates_to_webgl2_glsl() {
    for spec in TRANSITION_SHADERS {
        let (module, info) = parse_and_validate(spec.id, spec.source);
        let output = translate_to_webgl2(spec.id, &module, &info);
        assert!(output.starts_with("#version 300 es"), "{}: unexpected GLSL header", spec.id);
    }
}

#[test]
fn transition_shaders_bind_like_the_pipeline_layout() {
    let buffer_size = std::mem::size_of::<TransitionUniformBuffer>() as u32;
    for spec in TRANSITION_SHADERS {
        let (module, _) = parse_and_validate(spec.id, spec.source);
        let mut bindings = module
            .global_variables
            .iter()
            .filter_map(|(_, variable)| variable.binding.as_ref())
            .map(|binding| (binding.group, binding.binding))
            .collect::<Vec<_>>();
        bindings.sort();
        assert_eq!(bindings, vec![(0, 0), (0, 1), (1, 0), (1, 1), (2, 0)], "{}: bind groups", spec.id);
        let (_, ty) = module
            .types
            .iter()
            .find(|(_, ty)| ty.name.as_deref() == Some("TransitionUniforms"))
            .unwrap_or_else(|| panic!("{}: declares struct TransitionUniforms", spec.id));
        let naga::TypeInner::Struct { span, .. } = ty.inner else {
            panic!("{}: TransitionUniforms is not a struct", spec.id);
        };
        assert_eq!(span, buffer_size, "{}: TransitionUniforms must be 48 bytes", spec.id);
    }
}

#[test]
fn transition_shaders_only_use_explicit_level_sampling() {
    for spec in TRANSITION_SHADERS {
        let code: String = spec
            .source
            .lines()
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["textureSample(", "textureSampleBias(", "dpdx", "dpdy", "fwidth"] {
            assert!(!code.contains(forbidden), "{}: uses {forbidden}", spec.id);
        }
        assert!(code.contains("textureSampleLevel("), "{}: samples with textureSampleLevel", spec.id);
    }
}
