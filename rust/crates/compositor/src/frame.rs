use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        /// `rename_all` on the enum renames the variant tags only, not the fields of a struct
        /// variant, so upstream expected `effect_pass_groups` while TypeScript sends
        /// `effectPassGroups`: every effect layer failed the whole frame ("Invalid frame
        /// descriptor: missing field `effect_pass_groups`"). Fixed by the grade agent,
        /// 2026-10-20 (the snake_case spelling is still accepted).
        #[serde(rename = "effectPassGroups", alias = "effect_pass_groups")]
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
    /// A cut with a transition (Restorff). `from` and `to` are each composited over the
    /// current scene, mixed by the transition shader, and the result replaces the scene.
    Transition(TransitionDescriptor),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDescriptor {
    /// A transition shader id (`effects::TRANSITION_SHADERS`, e.g. "restorff-transition-whip").
    pub shader: String,
    /// 0 = only `from`, 1 = only `to`.
    pub progress: f32,
    #[serde(default)]
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
    /// Layers of the outgoing side (usually one clip), bottom to top.
    #[serde(default)]
    pub from: Vec<LayerDescriptor>,
    /// Layers of the incoming side.
    #[serde(default)]
    pub to: Vec<LayerDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}
