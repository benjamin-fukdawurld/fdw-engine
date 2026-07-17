struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>};

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
    @location(0) inPos: vec3<f32>
) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = projectionMatrix * viewMatrix * modelMatrix * vec4<f32>(inPos + offset, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput, @builtin(front_facing) face: bool) -> @location(0) vec4<f32> {
    if face {
        return vec4<f32>(0.0, 0.0, 1.0, 1.0);
    }
    else {
        return vec4<f32>(0.0, 1.0, 0.0, 1.0);
    }
}