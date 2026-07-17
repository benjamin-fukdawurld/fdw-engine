/**
 * WGSL shaders for basic mesh rendering with per-instance color + directional lighting.
 */
export const MESH_SHADER_CODE = /* wgsl */ `

struct CameraUniforms {
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
  color: vec4<f32>,
  _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) world_normal: vec3<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;

  let world_pos = model.model * vec4<f32>(in.position, 1.0);
  out.clip_position = camera.projection * camera.view * world_pos;

  // Transform normal (assuming no non-uniform scale for now)
  let normal_matrix = mat3x3<f32>(
    model.model[0].xyz,
    model.model[1].xyz,
    model.model[2].xyz,
  );
  out.world_normal = normalize(normal_matrix * in.normal);
  out.color = model.color;

  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Two-light setup for better visibility of all mesh faces
  let light_dir1 = normalize(vec3<f32>(0.3, 1.0, 0.5));
  let light_dir2 = normalize(vec3<f32>(-0.5, -0.3, 0.8));
  let ambient = 0.35;
  let diffuse1 = max(dot(in.world_normal, light_dir1), 0.0);
  let diffuse2 = max(dot(in.world_normal, light_dir2), 0.0);
  let lighting = ambient + diffuse1 * 0.55 + diffuse2 * 0.3;

  return vec4<f32>(in.color.rgb * lighting, in.color.a);
}
`;

/**
 * WGSL shaders for wireframe/edge line rendering.
 * Renders edges as unlit lines with a uniform color and model transform.
 */
export const LINE_SHADER_CODE = /* wgsl */ `

struct CameraUniforms {
  view: mat4x4<f32>,
  projection: mat4x4<f32>,
};

struct ModelUniforms {
  model: mat4x4<f32>,
  color: vec4<f32>,
  _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

struct LineVertexInput {
  @location(0) position: vec3<f32>,
};

struct LineVertexOutput {
  @builtin(position) clip_position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(in: LineVertexInput) -> LineVertexOutput {
  var out: LineVertexOutput;
  let world_pos = model.model * vec4<f32>(in.position, 1.0);
  out.clip_position = camera.projection * camera.view * world_pos;
  out.color = model.color;
  return out;
}

@fragment
fn fs_main(in: LineVertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
`;
