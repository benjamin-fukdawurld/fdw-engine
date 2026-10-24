// The levels of detail of a texture. Direct3D 12 has no blit: each level of
// each layer is drawn from the previous one, a full screen triangle
// sampling it with a linear filter.

#include "context.hpp"

#include <algorithm>

using namespace fdw;

namespace {

constexpr const char *Source = R"(
Texture2DArray<float4> source : register(t0);
SamplerState linearClamp : register(s0);

struct Varyings {
  float4 position : SV_Position;
  float2 uv : TEXCOORD0;
};

Varyings vs_main(uint vertex : SV_VertexID) {
  Varyings result;
  result.uv = float2((vertex << 1) & 2, vertex & 2);
  result.position = float4(result.uv * float2(2, -2) + float2(-1, 1), 0, 1);
  return result;
}

float4 ps_main(Varyings input) : SV_Target0 {
  return source.SampleLevel(linearClamp, float3(input.uv, 0), 0);
}
)";

// The root signature and the shaders, created once.
int prepare(fdw_dx_context *context) {
  auto &mipmaps = context->mipmaps;
  if (mipmaps.root) {
    return 0;
  }
  const char *vertex[] = {"-T", "vs_6_0", "-E", "vs_main"};
  const char *pixel[] = {"-T", "ps_6_0", "-E", "ps_main"};
  if (compileHlsl(Source, vertex, 4, &mipmaps.vertex) != 0 ||
      compileHlsl(Source, pixel, 4, &mipmaps.pixel) != 0) {
    return -1;
  }
  const D3D12_DESCRIPTOR_RANGE range{D3D12_DESCRIPTOR_RANGE_TYPE_SRV, 1, 0, 0,
                                     0};
  D3D12_ROOT_PARAMETER table{};
  table.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
  table.DescriptorTable = {1, &range};
  table.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
  D3D12_STATIC_SAMPLER_DESC sampler{};
  sampler.Filter = D3D12_FILTER_MIN_MAG_MIP_LINEAR;
  sampler.AddressU = sampler.AddressV = sampler.AddressW =
      D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
  sampler.MaxLOD = D3D12_FLOAT32_MAX;
  sampler.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
  D3D12_ROOT_SIGNATURE_DESC desc{1, &table, 1, &sampler,
                                 D3D12_ROOT_SIGNATURE_FLAG_NONE};
  ComPtr<ID3DBlob> blob;
  ComPtr<ID3DBlob> errors;
  HRESULT result = D3D12SerializeRootSignature(
      &desc, D3D_ROOT_SIGNATURE_VERSION_1_0, &blob, &errors);
  if (SUCCEEDED(result)) {
    result = context->device->CreateRootSignature(
        0, blob->GetBufferPointer(), blob->GetBufferSize(),
        IID_PPV_ARGS(&mipmaps.root));
  }
  return FAILED(result) ? fail("Creating the mipmap root signature", result)
                        : 0;
}

// The pipeline drawing into a format.
ID3D12PipelineState *pipeline(fdw_dx_context *context, DXGI_FORMAT format) {
  auto &cached = context->mipmaps.pipelines[format];
  if (cached) {
    return cached.Get();
  }
  D3D12_GRAPHICS_PIPELINE_STATE_DESC desc{};
  desc.pRootSignature = context->mipmaps.root.Get();
  desc.VS = {context->mipmaps.vertex.data(), context->mipmaps.vertex.size()};
  desc.PS = {context->mipmaps.pixel.data(), context->mipmaps.pixel.size()};
  desc.BlendState.RenderTarget[0].RenderTargetWriteMask =
      D3D12_COLOR_WRITE_ENABLE_ALL;
  desc.SampleMask = UINT_MAX;
  desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
  desc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
  desc.RasterizerState.DepthClipEnable = TRUE;
  desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
  desc.NumRenderTargets = 1;
  desc.RTVFormats[0] = format;
  desc.SampleDesc.Count = 1;
  const HRESULT result = context->device->CreateGraphicsPipelineState(
      &desc, IID_PPV_ARGS(&cached));
  if (FAILED(result)) {
    fail("Creating the mipmap pipeline", result);
    context->mipmaps.pipelines.erase(format);
    return nullptr;
  }
  return cached.Get();
}

// A transition of one subresource.
D3D12_RESOURCE_BARRIER transition(ID3D12Resource *resource, UINT subresource,
                                  D3D12_RESOURCE_STATES before,
                                  D3D12_RESOURCE_STATES after) {
  D3D12_RESOURCE_BARRIER barrier{};
  barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  barrier.Transition = {resource, subresource, before, after};
  return barrier;
}

} // namespace

namespace fdw {

int generateMipmaps(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
                    fdw_dx_texture *texture) {
  if (texture->levels <= 1) {
    return 0;
  }
  const FormatInfo *format = texture->format;
  if (format->depth || format->block > 1 || texture->is3d ||
      texture->samples > 1) {
    return fail("The levels of this texture cannot be drawn");
  }
  if (prepare(context) != 0) {
    return -1;
  }
  ID3D12PipelineState *state = pipeline(context, format->target);
  if (!state) {
    return -1;
  }
  // A shader view of each level read (every layer), a render target view
  // of each level written; freed once the GPU has drawn them.
  const uint32_t layers = texture->layers;
  const uint32_t views = (texture->levels - 1) * layers;
  const int64_t sources = context->views.allocate(views);
  const int64_t targets = context->rtvs.allocate(views);
  if (sources < 0 || targets < 0) {
    if (sources >= 0) {
      context->views.release(static_cast<uint32_t>(sources), views);
    }
    if (targets >= 0) {
      context->rtvs.release(static_cast<uint32_t>(targets), views);
    }
    return fail("No descriptors left to compute the levels of a texture");
  }
  defer(context, [context, sources, targets, views] {
    context->views.release(static_cast<uint32_t>(sources), views);
    context->rtvs.release(static_cast<uint32_t>(targets), views);
  });

  // Every level readable; each one written is a render target meanwhile.
  useTexture(context, list, texture, ShaderRead);
  ID3D12Resource *resource = texture->resource.Get();
  list->SetGraphicsRootSignature(context->mipmaps.root.Get());
  list->SetPipelineState(state);
  list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  uint32_t index = 0;
  for (uint32_t level = 1; level < texture->levels; level++) {
    const uint32_t width = std::max(texture->width >> level, 1u);
    const uint32_t height = std::max(texture->height >> level, 1u);
    const D3D12_VIEWPORT viewport{0, 0, static_cast<float>(width),
                                  static_cast<float>(height), 0, 1};
    const D3D12_RECT scissor{0, 0, static_cast<LONG>(width),
                             static_cast<LONG>(height)};
    list->RSSetViewports(1, &viewport);
    list->RSSetScissorRects(1, &scissor);
    for (uint32_t layer = 0; layer < layers; layer++, index++) {
      D3D12_SHADER_RESOURCE_VIEW_DESC source{};
      source.Format = format->srv;
      source.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
      source.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2DARRAY;
      source.Texture2DArray = {level - 1, 1, layer, 1, 0, 0};
      const uint32_t sourceIndex = static_cast<uint32_t>(sources) + index;
      context->device->CreateShaderResourceView(
          resource, &source, context->views.cpu(sourceIndex));
      D3D12_RENDER_TARGET_VIEW_DESC target{};
      target.Format = format->target;
      target.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2DARRAY;
      target.Texture2DArray = {level, layer, 1, 0};
      const D3D12_CPU_DESCRIPTOR_HANDLE rtv =
          context->rtvs.cpu(static_cast<uint32_t>(targets) + index);
      context->device->CreateRenderTargetView(resource, &target, rtv);

      const UINT written = level + layer * texture->levels;
      const D3D12_RESOURCE_BARRIER before =
          transition(resource, written, ShaderRead,
                     D3D12_RESOURCE_STATE_RENDER_TARGET);
      list->ResourceBarrier(1, &before);
      list->OMSetRenderTargets(1, &rtv, FALSE, nullptr);
      list->SetGraphicsRootDescriptorTable(0, context->views.gpu(sourceIndex));
      list->DrawInstanced(3, 1, 0, 0);
      // Readable by the next level.
      const D3D12_RESOURCE_BARRIER after =
          transition(resource, written, D3D12_RESOURCE_STATE_RENDER_TARGET,
                     ShaderRead);
      list->ResourceBarrier(1, &after);
    }
  }
  return 0;
}

} // namespace fdw
