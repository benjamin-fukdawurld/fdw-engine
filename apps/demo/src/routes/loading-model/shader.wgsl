struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>};

@group(0) @binding(0)
var<uniform> offset: vec3<f32>;

@group(0) @binding(1)
var<uniform> modelMatrix: mat4x4<f32>;

@group(0) @binding(2)
var<uniform> viewMatrix: mat4x4<f32>;

@group(0) @binding(3)
var<uniform> projectionMatrix: mat4x4<f32>;

@vertex
fn vs_main(
    @location(0) inPos: vec3<f32>,
    @location(1) inNormal: vec3<f32>, @location(2) inUV: vec2<f32>
) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = projectionMatrix * viewMatrix * modelMatrix * vec4<f32>(inPos + offset, 1.0);
    out.color = vec3<f32>(inNormal * 0.5 + 0.5); // Normalize normal to [0, 1] range for color
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color, 1.0);
}