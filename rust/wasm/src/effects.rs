#![cfg(target_arch = "wasm32")]

use effects::{ApplyEffectsOptions, EFFECT_SHADERS, EffectPass, TRANSITION_SHADERS, UniformValue};
use gpu::wgpu;
use js_sys::Object;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    import_canvas_texture, read_offscreen_canvas_property, read_serde_property, read_u32_property,
    render_texture_to_canvas, with_gpu_runtime,
};

struct ApplyEffectPassesOptions {
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
    passes: Vec<EffectPassInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectPassInput {
    shader: String,
    uniforms: Vec<EffectUniformInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EffectUniformInput {
    name: String,
    value: Vec<f32>,
}

#[wasm_bindgen(js_name = applyEffectPasses)]
pub fn apply_effect_passes(options: JsValue) -> Result<wgpu::web_sys::OffscreenCanvas, JsValue> {
    let ApplyEffectPassesOptions {
        source,
        width,
        height,
        passes,
    } = parse_apply_effect_passes_options(options)?;

    with_gpu_runtime(|runtime| {
        let source_texture = import_canvas_texture(
            &runtime.context,
            &source,
            width,
            height,
            "effects-input-texture",
        );
        let effect_passes = map_effect_passes(passes);
        let result_texture = runtime
            .effects
            .apply(
                &runtime.context,
                ApplyEffectsOptions {
                    source: &source_texture,
                    width,
                    height,
                    passes: &effect_passes,
                },
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        render_texture_to_canvas(&runtime.context, &result_texture, width, height)
    })
}

#[wasm_bindgen(typescript_custom_section)]
const EFFECT_SHADER_INFO_TYPES: &str = r#"
export interface EffectUniformInfo {
    /** Uniform name used in an effect pass, e.g. "u_zoom". */
    name: string;
    kind: "number" | "vec2" | "vec4";
    /** Used when a pass omits the uniform; absent means the uniform is required. */
    defaultValue?: number[];
}

export interface EffectShaderInfo {
    /** Shader id used as `EffectPass.shader`, e.g. "restorff-digital-zoom". */
    id: string;
    uniforms: EffectUniformInfo[];
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectUniformInfo {
    name: &'static str,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_value: Option<&'static [f32]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectShaderInfo {
    id: &'static str,
    uniforms: Vec<EffectUniformInfo>,
}

/// Every effect shader this build can run, with the uniforms each accepts. Works before
/// `initializeGpu()` (it reads the static registry, not the GPU).
#[wasm_bindgen(js_name = listEffectShaders, unchecked_return_type = "EffectShaderInfo[]")]
pub fn list_effect_shaders() -> Result<JsValue, JsValue> {
    let shaders = EFFECT_SHADERS
        .iter()
        .map(|spec| EffectShaderInfo {
            id: spec.id,
            uniforms: spec
                .uniforms
                .iter()
                .map(|uniform| EffectUniformInfo {
                    name: uniform.name,
                    kind: uniform.kind.as_str(),
                    default_value: uniform.default,
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    serde_wasm_bindgen::to_value(&shaders).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Every transition shader this build can run (`{ id, uniforms }`, same shape as effects).
/// A frame item `{ type: "transition", shader: id, progress, uniforms, from, to }` in
/// `renderFrame` uses one. Works before `initializeGpu()`.
#[wasm_bindgen(js_name = listTransitionShaders, unchecked_return_type = "EffectShaderInfo[]")]
pub fn list_transition_shaders() -> Result<JsValue, JsValue> {
    let shaders = TRANSITION_SHADERS
        .iter()
        .map(|spec| EffectShaderInfo {
            id: spec.id,
            uniforms: spec
                .uniforms
                .iter()
                .map(|uniform| EffectUniformInfo {
                    name: uniform.name,
                    kind: uniform.kind.as_str(),
                    default_value: uniform.default,
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    serde_wasm_bindgen::to_value(&shaders).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn map_effect_passes(effect_passes: Vec<EffectPassInput>) -> Vec<EffectPass> {
    effect_passes
        .into_iter()
        .map(|pass| EffectPass {
            shader: pass.shader,
            uniforms: pass
                .uniforms
                .into_iter()
                .map(|uniform| {
                    let value = if uniform.value.len() == 1 {
                        UniformValue::Number(uniform.value[0])
                    } else {
                        UniformValue::Vector(uniform.value)
                    };
                    (uniform.name, value)
                })
                .collect(),
        })
        .collect()
}

fn parse_apply_effect_passes_options(value: JsValue) -> Result<ApplyEffectPassesOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("applyEffectPasses expects an options object"))?;

    Ok(ApplyEffectPassesOptions {
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
        passes: read_serde_property(&object, "passes")?,
    })
}
