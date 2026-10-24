use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct EffectPass {
    pub shader: String,
    pub uniforms: HashMap<String, UniformValue>,
}

#[derive(Clone, Debug)]
pub enum UniformValue {
    Number(f32),
    Vector(Vec<f32>),
}

/// Shape of one uniform as TypeScript sends it (`number` or `number[]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UniformKind {
    /// One number, e.g. `u_sigma: 2.5`.
    Number,
    /// Two numbers, e.g. `u_direction: [1, 0]`.
    Vec2,
    /// Four numbers, e.g. `u_rect: [x, y, width, height]`.
    Vec4,
}

impl UniformKind {
    pub const fn component_count(self) -> usize {
        match self {
            Self::Number => 1,
            Self::Vec2 => 2,
            Self::Vec4 => 4,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Number => "number",
            Self::Vec2 => "vec2",
            Self::Vec4 => "vec4",
        }
    }
}

/// Where a uniform is written in the shared effect uniform buffer
/// (`EffectUniformBuffer`, 96 bytes; WGSL struct `EffectUniforms`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UniformSlot {
    /// `direction` (vec2f at byte 8). Used by the upstream gaussian blur.
    Direction,
    /// `scalars[index..]` (vec4f at byte 16). Used by the upstream gaussian blur.
    Scalar(usize),
    /// Flat float `index` into `params0..params3` (4 x vec4f from byte 32, 16 floats):
    /// float `i` is `params{i / 4}` component `i % 4`. Used by the Restorff effects.
    Param(usize),
}

/// One uniform a shader accepts.
#[derive(Clone, Copy, Debug)]
pub struct UniformSpec {
    /// Name TypeScript uses in `EffectPass.uniforms` (always `u_` + snake_case).
    pub name: &'static str,
    pub kind: UniformKind,
    pub slot: UniformSlot,
    /// Value used when a pass omits the uniform. `None` makes it required.
    pub default: Option<&'static [f32]>,
}

/// A fragment shader the effect pipeline can run, keyed by the id TypeScript sends.
#[derive(Clone, Copy, Debug)]
pub struct EffectShaderSpec {
    pub id: &'static str,
    /// WGSL source; must declare `fragment_main` and bind the texture/sampler at group 0
    /// and the uniform buffer at group 1 (see `shaders/*.wgsl`).
    pub source: &'static str,
    pub uniforms: &'static [UniformSpec],
}
