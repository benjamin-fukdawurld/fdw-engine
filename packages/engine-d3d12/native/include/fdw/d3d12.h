// The Direct3D 12 backend of the engine: a C API, without Direct3D types,
// usable from any host (the Node-API addon of @fdw/engine-d3d12, a FFI, a
// native application). It is the API of the Vulkan library
// (include/fdw/vulkan.h of @fdw/engine-vulkan), with the fdw_dx_ prefix:
// the same objects, ids and commands. The objects are opaque handles of a
// context; every function runs on the thread that created the context.
//
// Synchronization follows WebGPU: the library tracks the state of each
// resource and inserts the resource barriers itself
// (design/native-backends.md, §8.1, option A).

#ifndef FDW_D3D12_H
#define FDW_D3D12_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define FDW_DX_API __declspec(dllexport)
#else
#define FDW_DX_API __attribute__((visibility("default")))
#endif

typedef struct fdw_dx_context fdw_dx_context;
typedef struct fdw_dx_buffer fdw_dx_buffer;

// The message of the last error of the calling thread.
FDW_DX_API const char *fdw_dx_last_error(void);

// --- Context -----------------------------------------------------------------

typedef struct fdw_dx_context_options {
  // Enables the debug layer when it is installed (the Graphics Tools of
  // Windows): its messages are kept, see fdw_dx_message.
  int32_t validation;
  const char *application;
  // WARP, the software rasterizer of Windows, instead of the GPU.
  int32_t warp;
} fdw_dx_context_options;

// Creates a device on the high performance GPU (not a software adapter,
// unless options->warp),
// feature level 11.0 and Shader Model 6.0 at least, with its direct queue.
// Returns NULL on error.
FDW_DX_API fdw_dx_context *
fdw_dx_context_create(const fdw_dx_context_options *options);
// Waits for the GPU, then destroys the context and every object left.
FDW_DX_API void fdw_dx_context_destroy(fdw_dx_context *context);
FDW_DX_API const char *fdw_dx_device_name(const fdw_dx_context *context);
// Whether the debug layer is active.
FDW_DX_API int32_t fdw_dx_validation_enabled(const fdw_dx_context *context);
// Waits until the GPU has run every submitted command.
FDW_DX_API int fdw_dx_wait_idle(fdw_dx_context *context);

// The warnings and errors of the debug layer since the last clear.
FDW_DX_API size_t fdw_dx_message_count(fdw_dx_context *context);
FDW_DX_API const char *fdw_dx_message(const fdw_dx_context *context,
                                      size_t index);
FDW_DX_API void fdw_dx_clear_messages(fdw_dx_context *context);

// --- Buffers -------------------------------------------------------------------

// Usages of a buffer. Every buffer can be written and read back.
enum {
  FDW_DX_BUFFER_UNIFORM = 1 << 0,
  FDW_DX_BUFFER_STORAGE = 1 << 1,
  FDW_DX_BUFFER_VERTEX = 1 << 2,
  FDW_DX_BUFFER_INDEX = 1 << 3,
  FDW_DX_BUFFER_INDIRECT = 1 << 4,
  FDW_DX_BUFFER_COPY_SRC = 1 << 5,
  FDW_DX_BUFFER_COPY_DST = 1 << 6,
};

// A buffer in GPU memory, filled with zeros. Returns NULL on error.
FDW_DX_API fdw_dx_buffer *fdw_dx_buffer_create(fdw_dx_context *context,
                                               uint64_t size, uint32_t usage,
                                               const char *label);
// Destroyed once the GPU no longer uses it.
FDW_DX_API void fdw_dx_buffer_destroy(fdw_dx_context *context,
                                      fdw_dx_buffer *buffer);
// Writes data, as queue.writeBuffer in WebGPU: the data is copied now, and
// written in the order of the queue, before the commands submitted next.
FDW_DX_API int fdw_dx_buffer_write(fdw_dx_context *context,
                                   fdw_dx_buffer *buffer, uint64_t offset,
                                   const void *data, uint64_t size);

// Reads a range of a buffer back, asynchronously: starts the copy (after
// every write and command submitted before) and returns a ticket in
// `ticket`. fdw_dx_read_ready tells when the data is there, fdw_dx_read_take
// copies it out and forgets the ticket.
FDW_DX_API int fdw_dx_buffer_read(fdw_dx_context *context,
                                  fdw_dx_buffer *buffer, uint64_t offset,
                                  uint64_t size, uint64_t *ticket);
// 1 when the data of the ticket is ready, 0 when not yet, -1 on error.
FDW_DX_API int fdw_dx_read_ready(fdw_dx_context *context, uint64_t ticket);
FDW_DX_API int fdw_dx_read_take(fdw_dx_context *context, uint64_t ticket,
                                void *data, uint64_t size);

// Submits the writes made since the last submission (the reads and the
// command submissions do it too).
FDW_DX_API int fdw_dx_flush(fdw_dx_context *context);

// Every object has an id, unique in its context: the commands refer to the
// objects by id (fdw_dx_submit).
FDW_DX_API uint32_t fdw_dx_buffer_id(const fdw_dx_buffer *buffer);

// --- Textures --------------------------------------------------------------------

typedef struct fdw_dx_texture fdw_dx_texture;
typedef struct fdw_dx_sampler fdw_dx_sampler;

// Usages of a texture. Every texture can be written and read back.
enum {
  FDW_DX_TEXTURE_SAMPLED = 1 << 0,
  FDW_DX_TEXTURE_STORAGE = 1 << 1,
  FDW_DX_TEXTURE_RENDER_ATTACHMENT = 1 << 2,
  FDW_DX_TEXTURE_COPY_SRC = 1 << 3,
  FDW_DX_TEXTURE_COPY_DST = 1 << 4,
};

typedef struct fdw_dx_texture_options {
  // A format of the engine: "rgba8unorm", "rgba16float", "depth24plus"…
  const char *format;
  // "2d", "2d-array", "3d" or "cube".
  const char *type;
  uint32_t width;
  uint32_t height;
  // Layers of an array (6 for a cube), depth of a 3d texture.
  uint32_t layers;
  uint32_t sample_count;
  // Levels of detail (1: none). Computed from the first level by
  // fdw_dx_texture_generate_mipmaps or FDW_DX_CMD_GENERATE_MIPMAPS.
  uint32_t mip_level_count;
  uint32_t usage;
  const char *label;
} fdw_dx_texture_options;

FDW_DX_API fdw_dx_texture *
fdw_dx_texture_create(fdw_dx_context *context,
                      const fdw_dx_texture_options *options);
// Destroyed once the GPU no longer uses it.
FDW_DX_API void fdw_dx_texture_destroy(fdw_dx_context *context,
                                       fdw_dx_texture *texture);
FDW_DX_API uint32_t fdw_dx_texture_id(const fdw_dx_texture *texture);
// Bytes per pixel of the format of a texture.
FDW_DX_API uint32_t fdw_dx_texture_pixel_size(const fdw_dx_texture *texture);
// Writes the whole first level (every layer), as queue.writeTexture: rows
// from the top, tightly packed, layer after layer; in the order of the
// queue.
FDW_DX_API int fdw_dx_texture_write(fdw_dx_context *context,
                                    fdw_dx_texture *texture, const void *data,
                                    uint64_t size);
// Writes the layers [layer, layer + layer_count) of a level (the depth of
// a 3d texture): rows from the top, tightly packed, layer after layer; rows
// of blocks for the compressed formats (a level of 2 × 2 pixels is a block
// of 4 × 4). In the order of the queue; the other levels are kept.
FDW_DX_API int fdw_dx_texture_write_level(fdw_dx_context *context,
                                          fdw_dx_texture *texture,
                                          uint32_t level, uint32_t layer,
                                          uint32_t layer_count,
                                          const void *data, uint64_t size);
// Computes the levels of a texture after the first one, in the order of the
// queue (after the writes before), as FDW_DX_CMD_GENERATE_MIPMAPS.
FDW_DX_API int fdw_dx_texture_generate_mipmaps(fdw_dx_context *context,
                                               fdw_dx_texture *texture);
// Reads a region of the first level of the first layer back (x, y from the
// top left corner), rows from the top, tightly packed: a ticket, as
// fdw_dx_buffer_read.
FDW_DX_API int fdw_dx_texture_read(fdw_dx_context *context,
                                   fdw_dx_texture *texture, uint32_t x,
                                   uint32_t y, uint32_t width, uint32_t height,
                                   uint64_t *ticket);

typedef struct fdw_dx_sampler_options {
  // "nearest" or "linear".
  const char *min_filter;
  const char *mag_filter;
  const char *mipmap_filter;
  // "clamp-to-edge", "repeat" or "mirror-repeat".
  const char *wrap_u;
  const char *wrap_v;
  const char *wrap_w;
  float max_anisotropy;
  // A comparison function ("less-equal"…) for comparison samplers, or NULL.
  const char *compare;
  const char *label;
} fdw_dx_sampler_options;

FDW_DX_API fdw_dx_sampler *
fdw_dx_sampler_create(fdw_dx_context *context,
                      const fdw_dx_sampler_options *options);
// The color attachments of a render pass (8), and whether the color targets
// of a pipeline can have different blend states (always).
FDW_DX_API uint32_t
fdw_dx_max_color_attachments(const fdw_dx_context *context);
FDW_DX_API int32_t fdw_dx_independent_blend(const fdw_dx_context *context);
// The highest max_anisotropy of the samplers (16); higher ones are clamped
// to it.
FDW_DX_API float fdw_dx_max_anisotropy(const fdw_dx_context *context);
// Whether the device can write and sample textures of a format of the
// engine ("bc7-rgba-unorm"…): 1 or 0.
FDW_DX_API int32_t fdw_dx_format_supported(const fdw_dx_context *context,
                                           const char *format);
FDW_DX_API void fdw_dx_sampler_destroy(fdw_dx_context *context,
                                       fdw_dx_sampler *sampler);
FDW_DX_API uint32_t fdw_dx_sampler_id(const fdw_dx_sampler *sampler);

// --- Shaders -----------------------------------------------------------------------

typedef struct fdw_dx_shader fdw_dx_shader;

// Compiles an entry point of an HLSL module to DXIL with the DXC library
// (loaded at the first call, with the validator that signs the DXIL:
// FDW_DXC_LIBRARY, the Windows SDK, the Vulkan SDK, or the system).
// `arguments` are the DXC arguments (dxcArguments of the TypeScript side,
// for Direct3D 12), `count` of them.
FDW_DX_API fdw_dx_shader *fdw_dx_shader_create(fdw_dx_context *context,
                                               const char *hlsl,
                                               const char *const *arguments,
                                               uint32_t count,
                                               const char *label);
FDW_DX_API void fdw_dx_shader_destroy(fdw_dx_context *context,
                                      fdw_dx_shader *shader);
// Compiles an entry point of an HLSL module to DXIL, without creating a
// shader: `*code` (freed by fdw_dx_free_code) of `*size` bytes, for a cache
// of the programs. Returns 0, or -1 on error.
FDW_DX_API int fdw_dx_compile_hlsl(const char *hlsl,
                                   const char *const *arguments,
                                   uint32_t count, uint8_t **code,
                                   size_t *size);
FDW_DX_API void fdw_dx_free_code(uint8_t *code);
// Creates a shader from DXIL compiled before (fdw_dx_compile_hlsl, or a
// cache): the arguments give its stage.
FDW_DX_API fdw_dx_shader *fdw_dx_shader_create_from_code(
    fdw_dx_context *context, const uint8_t *code, size_t size,
    const char *const *arguments, uint32_t count, const char *label);
// The version of the DXC library, with its commit when it tells it: a key
// of the cache of the programs. NULL when DXC is missing.
FDW_DX_API const char *fdw_dx_dxc_version(void);

// --- Groups of resources -------------------------------------------------------

typedef struct fdw_dx_group_layout fdw_dx_group_layout;
typedef struct fdw_dx_group fdw_dx_group;

typedef enum fdw_dx_binding_kind {
  FDW_DX_BINDING_UNIFORM = 0,
  FDW_DX_BINDING_TEXTURE = 1,
  FDW_DX_BINDING_SAMPLER = 2,
  FDW_DX_BINDING_STORAGE_READ = 3,
  FDW_DX_BINDING_STORAGE_READ_WRITE = 4,
  // A top level acceleration structure (fdw_dx_top_level), read by ray
  // queries.
  FDW_DX_BINDING_ACCELERATION_STRUCTURE = 5,
} fdw_dx_binding_kind;

typedef struct fdw_dx_layout_binding {
  uint32_t binding;
  fdw_dx_binding_kind kind;
  // For the storage buffers: the size of an element of the structured
  // buffer, in bytes.
  uint32_t stride;
} fdw_dx_layout_binding;

// The layout of a group, visible to every stage. A pipeline puts the group
// at its index in the register space of that index: its resources in a
// descriptor table, its samplers in another one.
FDW_DX_API fdw_dx_group_layout *
fdw_dx_group_layout_create(fdw_dx_context *context,
                           const fdw_dx_layout_binding *bindings,
                           uint32_t count);
FDW_DX_API uint32_t fdw_dx_group_layout_id(const fdw_dx_group_layout *layout);

typedef struct fdw_dx_group_entry {
  uint32_t binding;
  // The id of a buffer, a texture or a sampler, as the layout says.
  uint32_t object;
} fdw_dx_group_entry;

// A group of resources (descriptors in the shader visible heaps), for
// set_group commands.
FDW_DX_API fdw_dx_group *fdw_dx_group_create(fdw_dx_context *context,
                                             fdw_dx_group_layout *layout,
                                             const fdw_dx_group_entry *entries,
                                             uint32_t count);
FDW_DX_API void fdw_dx_group_destroy(fdw_dx_context *context,
                                     fdw_dx_group *group);
FDW_DX_API uint32_t fdw_dx_group_id(const fdw_dx_group *group);

// --- Pipelines ---------------------------------------------------------------------

typedef struct fdw_dx_pipeline fdw_dx_pipeline;

typedef struct fdw_dx_vertex_attribute {
  // The semantic index: ATTRIBUTE<location>.
  uint32_t location;
  // A vertex format of the engine: "float32x3", "unorm8x4"…
  const char *format;
  uint32_t offset;
} fdw_dx_vertex_attribute;

typedef struct fdw_dx_vertex_buffer {
  uint32_t stride;
  // 0: per vertex, 1: per instance.
  uint32_t per_instance;
  const fdw_dx_vertex_attribute *attributes;
  uint32_t attribute_count;
} fdw_dx_vertex_buffer;

typedef struct fdw_dx_blend_component {
  // "zero", "one", "src-alpha", "one-minus-src-alpha", "dst-alpha",
  // "one-minus-dst-alpha".
  const char *src_factor;
  const char *dst_factor;
  // "add", "subtract", "reverse-subtract", "min", "max".
  const char *operation;
} fdw_dx_blend_component;

typedef struct fdw_dx_color_target {
  const char *format;
  int32_t blend;
  fdw_dx_blend_component color;
  fdw_dx_blend_component alpha;
} fdw_dx_color_target;

typedef struct fdw_dx_render_pipeline_options {
  fdw_dx_shader *vertex;
  // NULL for depth-only pipelines without fragment work.
  fdw_dx_shader *fragment;
  // The layouts of the groups 0, 1… (NULL for an empty group).
  fdw_dx_group_layout *const *groups;
  uint32_t group_count;
  const fdw_dx_vertex_buffer *vertex_buffers;
  uint32_t vertex_buffer_count;
  // "triangle-list", "triangle-strip", "line-list", "line-strip",
  // "point-list".
  const char *topology;
  // "none", "front", "back".
  const char *cull_mode;
  // "ccw", "cw": counter-clockwise in clip space, y up (WebGPU).
  const char *front_face;
  // The depth attachment format, or NULL without depth.
  const char *depth_format;
  int32_t depth_write;
  // A comparison function: "less", "always"…
  const char *depth_compare;
  float depth_bias;
  float depth_bias_slope_scale;
  const fdw_dx_color_target *targets;
  uint32_t target_count;
  uint32_t sample_count;
  const char *label;
} fdw_dx_render_pipeline_options;

FDW_DX_API fdw_dx_pipeline *
fdw_dx_render_pipeline_create(fdw_dx_context *context,
                              const fdw_dx_render_pipeline_options *options);
// A compute pipeline: a compute shader and the layouts of its groups.
FDW_DX_API fdw_dx_pipeline *fdw_dx_compute_pipeline_create(
    fdw_dx_context *context, fdw_dx_shader *shader,
    fdw_dx_group_layout *const *groups, uint32_t group_count,
    const char *label);
// Whether the device has the ray tracing pipelines (with ray queries).
FDW_DX_API int32_t
fdw_dx_ray_tracing_pipeline_supported(const fdw_dx_context *context);
// A ray tracing pipeline (a state object): a library of shaders (rg_main,
// ms_main, ch_main, and with any_hit, ah_main), and the layouts of its
// groups. Its dispatches trace a ray per thread of their workgroups of
// `workgroup_size` (x, y, z).
FDW_DX_API fdw_dx_pipeline *fdw_dx_ray_tracing_pipeline_create(
    fdw_dx_context *context, fdw_dx_shader *shader, uint32_t any_hit,
    const uint32_t *workgroup_size, fdw_dx_group_layout *const *groups,
    uint32_t group_count, const char *label);
FDW_DX_API void fdw_dx_pipeline_destroy(fdw_dx_context *context,
                                        fdw_dx_pipeline *pipeline);
FDW_DX_API uint32_t fdw_dx_pipeline_id(const fdw_dx_pipeline *pipeline);

// --- Swapchains --------------------------------------------------------------------

typedef struct fdw_dx_swapchain fdw_dx_swapchain;

// A native window, as fdw_window_native_handle of @fdw/engine-native gives
// it: system 3 Win32 (HINSTANCE, HWND), the only one supported.
typedef struct fdw_dx_window_handle {
  int32_t system;
  uint64_t display;
  uint64_t window;
} fdw_dx_window_handle;

// A flip model swapchain presenting into a window: with the vertical
// synchronization (vsync), else without waiting (tearing where the display
// allows it). Returns NULL on error.
FDW_DX_API fdw_dx_swapchain *
fdw_dx_swapchain_create(fdw_dx_context *context,
                        const fdw_dx_window_handle *window, uint32_t width,
                        uint32_t height, int32_t vsync);
FDW_DX_API void fdw_dx_swapchain_destroy(fdw_dx_context *context,
                                         fdw_dx_swapchain *swapchain);
// The format of the images: "bgra8unorm".
FDW_DX_API const char *
fdw_dx_swapchain_format(const fdw_dx_swapchain *swapchain);
// Acquires the next image to render into; waits while two frames are in
// flight. Resizes the images when the window size changed: `recreated` is
// then set, and the images are new. Returns the index of the image, or -1
// on error.
FDW_DX_API int fdw_dx_swapchain_acquire(fdw_dx_context *context,
                                        fdw_dx_swapchain *swapchain,
                                        uint32_t width, uint32_t height,
                                        int32_t *recreated);
FDW_DX_API uint32_t
fdw_dx_swapchain_image_count(const fdw_dx_swapchain *swapchain);
// The size of the images, in pixels.
FDW_DX_API void fdw_dx_swapchain_extent(const fdw_dx_swapchain *swapchain,
                                        uint32_t *width, uint32_t *height);
// An image of the swapchain, as a texture of the commands (owned by the
// swapchain: fdw_dx_texture_destroy ignores it).
FDW_DX_API fdw_dx_texture *
fdw_dx_swapchain_image(const fdw_dx_swapchain *swapchain, uint32_t index);
// Presents the image acquired, after the commands submitted so far.
FDW_DX_API int fdw_dx_swapchain_present(fdw_dx_context *context,
                                        fdw_dx_swapchain *swapchain);

// --- Timestamps --------------------------------------------------------------------

// Timestamp queries, to measure the GPU duration of commands: written by
// FDW_DX_CMD_WRITE_TIMESTAMP, reset by FDW_DX_CMD_RESET_QUERIES, read
// without waiting.
typedef struct fdw_dx_query_pool fdw_dx_query_pool;

// Whether the queue of the context writes timestamps.
FDW_DX_API int fdw_dx_timestamps_supported(const fdw_dx_context *context);
// A pool of `count` timestamp queries; NULL on error (see
// fdw_dx_last_error).
FDW_DX_API fdw_dx_query_pool *fdw_dx_query_pool_create(fdw_dx_context *context,
                                                       uint32_t count);
// Destroyed once the GPU no longer uses it.
FDW_DX_API void fdw_dx_query_pool_destroy(fdw_dx_context *context,
                                          fdw_dx_query_pool *pool);
FDW_DX_API uint32_t fdw_dx_query_pool_id(const fdw_dx_query_pool *pool);
// The timestamps of queries [first, first + count), in nanoseconds, without
// waiting: returns 1 when all of them are available, 0 when some are not
// yet (`nanoseconds` is then unspecified), -1 on error.
FDW_DX_API int fdw_dx_query_pool_read(fdw_dx_context *context,
                                      fdw_dx_query_pool *pool, uint32_t first,
                                      uint32_t count, double *nanoseconds);

// --- Acceleration structures -------------------------------------------------------

// Ray queries (DXR 1.1: raytracing tier 1.1 and Shader Model 6.5), where
// the device has them. 1 or 0.
FDW_DX_API int32_t fdw_dx_ray_query_supported(const fdw_dx_context *context);

typedef struct fdw_dx_bottom_level fdw_dx_bottom_level;
typedef struct fdw_dx_top_level fdw_dx_top_level;

// The flags of a bottom level.
enum {
  // Its vertices move on the GPU: refit by FDW_DX_CMD_REFIT_BOTTOM_LEVEL.
  FDW_DX_BOTTOM_LEVEL_DYNAMIC = 1,
};

// The acceleration structure of a triangle mesh: positions (xyz per vertex,
// `vertex_count` of them) and indices (3 per triangle). Built in the order
// of the queue, before the commands submitted next. NULL on error.
FDW_DX_API fdw_dx_bottom_level *
fdw_dx_bottom_level_create(fdw_dx_context *context, const float *positions,
                           uint32_t vertex_count, const uint32_t *indices,
                           uint32_t index_count, uint32_t flags,
                           const char *label);
// Destroyed once the GPU no longer uses it.
FDW_DX_API void fdw_dx_bottom_level_destroy(fdw_dx_context *context,
                                            fdw_dx_bottom_level *bottom);
FDW_DX_API uint32_t fdw_dx_bottom_level_id(const fdw_dx_bottom_level *bottom);

// An instance of a top level structure.
typedef struct fdw_dx_instance {
  // Object to world: the 3 rows of a 3 × 4 matrix.
  float transform[12];
  // The id of its bottom level.
  uint32_t bottom_level;
  // 8 bits: the rays sharing a bit with it see it; bit 8 set, it is not
  // opaque (its candidate hits go to the ray queries that test them).
  uint32_t mask;
} fdw_dx_instance;

// The acceleration structure of a scene, for `capacity` instances (it grows
// when updated with more). NULL on error.
FDW_DX_API fdw_dx_top_level *fdw_dx_top_level_create(fdw_dx_context *context,
                                                     uint32_t capacity,
                                                     const char *label);
// Sets the instances of the next build (FDW_DX_CMD_BUILD_TOP_LEVEL), in the
// order of the queue. Returns 1 when the structure was replaced by a larger
// one (the groups holding it must be made again), 0 otherwise, -1 on error.
FDW_DX_API int fdw_dx_top_level_update(fdw_dx_context *context,
                                       fdw_dx_top_level *top,
                                       const fdw_dx_instance *instances,
                                       uint32_t count);
// Destroyed once the GPU no longer uses it.
FDW_DX_API void fdw_dx_top_level_destroy(fdw_dx_context *context,
                                         fdw_dx_top_level *top);
FDW_DX_API uint32_t fdw_dx_top_level_id(const fdw_dx_top_level *top);

// --- Commands --------------------------------------------------------------------

// The commands of a submission: 32-bit words, each command an opcode then
// its operands; objects are given by id, floats by their bits, 64-bit
// values as two words (low, high). The same as those of the Vulkan library.
enum {
  // colorCount, then per color: target, load (0 clear, 1 load), clear r, g,
  // b, a (floats), resolve target (0: none); then the depth target (0:
  // none), its load and its clear depth (float).
  FDW_DX_CMD_BEGIN_RENDER_PASS = 1,
  FDW_DX_CMD_END_RENDER_PASS = 2,
  // source, source offset (64), destination, destination offset (64),
  // size (64).
  FDW_DX_CMD_COPY_BUFFER = 3,
  // source, destination, width, height: from the top left corners.
  FDW_DX_CMD_COPY_TEXTURE = 4,
  // pipeline.
  FDW_DX_CMD_SET_PIPELINE = 5,
  // index, group.
  FDW_DX_CMD_SET_GROUP = 6,
  // slot, buffer.
  FDW_DX_CMD_SET_VERTEX_BUFFER = 7,
  // buffer, format (0: uint16, 1: uint32).
  FDW_DX_CMD_SET_INDEX_BUFFER = 8,
  // vertex count, instance count, first instance.
  FDW_DX_CMD_DRAW = 9,
  // index count, instance count, first instance.
  FDW_DX_CMD_DRAW_INDEXED = 10,
  // x, y, width, height (floats), in pixels from the top left corner.
  FDW_DX_CMD_SET_VIEWPORT = 11,
  // A compute pass: set_pipeline, set_group and dispatches until its end.
  FDW_DX_CMD_BEGIN_COMPUTE_PASS = 12,
  FDW_DX_CMD_END_COMPUTE_PASS = 13,
  // x, y, z workgroups.
  FDW_DX_CMD_DISPATCH = 14,
  // buffer (three u32: x, y, z), offset (64).
  FDW_DX_CMD_DISPATCH_INDIRECT = 15,
  // Outside of the passes. pool, first, count: before writing them again.
  FDW_DX_CMD_RESET_QUERIES = 16,
  // Outside of the passes. pool, index: the time when the commands before
  // are complete.
  FDW_DX_CMD_WRITE_TIMESTAMP = 17,
  // Outside of the passes. texture: computes its levels after the first
  // one, each drawn from the previous one.
  FDW_DX_CMD_GENERATE_MIPMAPS = 18,
  // Outside of the passes. top level: builds it from its last update; the
  // passes after it trace rays against it.
  FDW_DX_CMD_BUILD_TOP_LEVEL = 19,
  // Outside of the passes. bottom level (dynamic), buffer, offset (64),
  // stride: refits it to the positions of its vertices in the buffer (xyz
  // float32 of the vertex v at offset + v × stride), before the builds of
  // the top levels holding it.
  FDW_DX_CMD_REFIT_BOTTOM_LEVEL = 20,
};

// Records the commands into a command list, with the barriers the
// resources need, and submits them after the pending writes.
FDW_DX_API int fdw_dx_submit(fdw_dx_context *context, const uint32_t *words,
                             size_t count);

#ifdef __cplusplus
}
#endif

#endif
