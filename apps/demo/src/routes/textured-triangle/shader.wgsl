struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> offset: vec3<f32>;

@vertex
fn vs_main(
    @location(0) inPos: vec3<f32>,
    @location(1) inUv: vec2<f32>
) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = vec4<f32>(inPos + offset, 1.0);
    out.uv = inUv;
    return out;
}

@group(0) @binding(1)
var texture: texture_2d<f32>;

@group(0) @binding(2)
var texSampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(texture, texSampler, in.uv);
}