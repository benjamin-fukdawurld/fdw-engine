#version 450

// A triangle turning with the time, kept undistorted by the aspect ratio.
layout(push_constant) uniform Push {
  float time;
  float aspect;
} push;

layout(location = 0) out vec3 color;

const vec2 positions[3] = vec2[](vec2(0.0, -0.6), vec2(0.52, 0.3), vec2(-0.52, 0.3));
const vec3 colors[3] = vec3[](vec3(1.0, 0.2, 0.2), vec3(0.2, 1.0, 0.2), vec3(0.2, 0.4, 1.0));

void main() {
  float c = cos(push.time);
  float s = sin(push.time);
  vec2 p = mat2(c, s, -s, c) * positions[gl_VertexIndex];
  gl_Position = vec4(p.x / push.aspect, p.y, 0.0, 1.0);
  color = colors[gl_VertexIndex];
}
