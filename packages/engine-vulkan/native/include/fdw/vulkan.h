// The Vulkan backend of the engine: a C API, without Vulkan types, usable
// from any host (the Node-API addon of @fdw/engine-vulkan, a FFI, a native
// application). The objects are opaque handles of a context; every
// function runs on the thread that created the context.
//
// Synchronization follows WebGPU: the library tracks how each resource was
// last used and inserts the barriers itself (design/native-backends.md,
// §8.1, option A).

#ifndef FDW_VULKAN_H
#define FDW_VULKAN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define FDW_VK_API __declspec(dllexport)
#else
#define FDW_VK_API __attribute__((visibility("default")))
#endif

typedef struct fdw_vk_context fdw_vk_context;
typedef struct fdw_vk_buffer fdw_vk_buffer;

// The message of the last error of the calling thread.
FDW_VK_API const char *fdw_vk_last_error(void);

// --- Context -----------------------------------------------------------------

typedef struct fdw_vk_context_options {
  // Enables the Khronos validation layer when it is installed (the Vulkan
  // SDK): its messages are kept, see fdw_vk_message.
  int32_t validation;
  const char *application;
} fdw_vk_context_options;

// Creates an instance and a device: the first discrete GPU with Vulkan 1.3,
// dynamic rendering and synchronization2, else any such GPU. Returns NULL
// on error.
FDW_VK_API fdw_vk_context *
fdw_vk_context_create(const fdw_vk_context_options *options);
// Waits for the GPU, then destroys the context and every object left.
FDW_VK_API void fdw_vk_context_destroy(fdw_vk_context *context);
FDW_VK_API const char *fdw_vk_device_name(const fdw_vk_context *context);
// Whether the validation layer is active.
FDW_VK_API int32_t fdw_vk_validation_enabled(const fdw_vk_context *context);
// Waits until the GPU has run every submitted command.
FDW_VK_API int fdw_vk_wait_idle(fdw_vk_context *context);

// The warnings and errors of the validation layer since the last clear.
FDW_VK_API size_t fdw_vk_message_count(const fdw_vk_context *context);
FDW_VK_API const char *fdw_vk_message(const fdw_vk_context *context,
                                      size_t index);
FDW_VK_API void fdw_vk_clear_messages(fdw_vk_context *context);

// --- Buffers -------------------------------------------------------------------

// Usages of a buffer. Every buffer can be written and read back.
enum {
  FDW_VK_BUFFER_UNIFORM = 1 << 0,
  FDW_VK_BUFFER_STORAGE = 1 << 1,
  FDW_VK_BUFFER_VERTEX = 1 << 2,
  FDW_VK_BUFFER_INDEX = 1 << 3,
  FDW_VK_BUFFER_INDIRECT = 1 << 4,
  FDW_VK_BUFFER_COPY_SRC = 1 << 5,
  FDW_VK_BUFFER_COPY_DST = 1 << 6,
};

// A buffer in GPU memory. Returns NULL on error.
FDW_VK_API fdw_vk_buffer *fdw_vk_buffer_create(fdw_vk_context *context,
                                               uint64_t size, uint32_t usage,
                                               const char *label);
// Destroyed once the GPU no longer uses it.
FDW_VK_API void fdw_vk_buffer_destroy(fdw_vk_context *context,
                                      fdw_vk_buffer *buffer);
// Writes data, as queue.writeBuffer in WebGPU: the data is copied now, and
// written in the order of the queue, before the commands submitted next.
FDW_VK_API int fdw_vk_buffer_write(fdw_vk_context *context,
                                   fdw_vk_buffer *buffer, uint64_t offset,
                                   const void *data, uint64_t size);

// Reads a range of a buffer back, asynchronously: starts the copy (after
// every write and command submitted before) and returns a ticket in
// `ticket`. fdw_vk_read_ready tells when the data is there, fdw_vk_read_take
// copies it out and forgets the ticket.
FDW_VK_API int fdw_vk_buffer_read(fdw_vk_context *context,
                                  fdw_vk_buffer *buffer, uint64_t offset,
                                  uint64_t size, uint64_t *ticket);
// 1 when the data of the ticket is ready, 0 when not yet, -1 on error.
FDW_VK_API int fdw_vk_read_ready(fdw_vk_context *context, uint64_t ticket);
FDW_VK_API int fdw_vk_read_take(fdw_vk_context *context, uint64_t ticket,
                                void *data, uint64_t size);

// Submits the writes made since the last submission (the reads and the
// command submissions do it too).
FDW_VK_API int fdw_vk_flush(fdw_vk_context *context);

// Every object has an id, unique in its context: the commands refer to the
// objects by id (fdw_vk_submit).
FDW_VK_API uint32_t fdw_vk_buffer_id(const fdw_vk_buffer *buffer);

// --- Textures --------------------------------------------------------------------

typedef struct fdw_vk_texture fdw_vk_texture;
typedef struct fdw_vk_sampler fdw_vk_sampler;

// Usages of a texture. Every texture can be written and read back.
enum {
  FDW_VK_TEXTURE_SAMPLED = 1 << 0,
  FDW_VK_TEXTURE_STORAGE = 1 << 1,
  FDW_VK_TEXTURE_RENDER_ATTACHMENT = 1 << 2,
  FDW_VK_TEXTURE_COPY_SRC = 1 << 3,
  FDW_VK_TEXTURE_COPY_DST = 1 << 4,
};

typedef struct fdw_vk_texture_options {
  // A format of the engine: "rgba8unorm", "rgba16float", "depth24plus"…
  const char *format;
  // "2d", "2d-array", "3d" or "cube".
  const char *type;
  uint32_t width;
  uint32_t height;
  // Layers of an array (6 for a cube), depth of a 3d texture.
  uint32_t layers;
  uint32_t sample_count;
  uint32_t usage;
  const char *label;
} fdw_vk_texture_options;

FDW_VK_API fdw_vk_texture *
fdw_vk_texture_create(fdw_vk_context *context,
                      const fdw_vk_texture_options *options);
// Destroyed once the GPU no longer uses it.
FDW_VK_API void fdw_vk_texture_destroy(fdw_vk_context *context,
                                       fdw_vk_texture *texture);
FDW_VK_API uint32_t fdw_vk_texture_id(const fdw_vk_texture *texture);
// Bytes per pixel of the format of a texture.
FDW_VK_API uint32_t fdw_vk_texture_pixel_size(const fdw_vk_texture *texture);
// Writes the whole texture (every layer), as queue.writeTexture: rows from
// the top, tightly packed, layer after layer; in the order of the queue.
FDW_VK_API int fdw_vk_texture_write(fdw_vk_context *context,
                                    fdw_vk_texture *texture, const void *data,
                                    uint64_t size);
// Reads the first layer back, rows from the top, tightly packed: a ticket,
// as fdw_vk_buffer_read.
FDW_VK_API int fdw_vk_texture_read(fdw_vk_context *context,
                                   fdw_vk_texture *texture, uint64_t *ticket);

typedef struct fdw_vk_sampler_options {
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
} fdw_vk_sampler_options;

FDW_VK_API fdw_vk_sampler *
fdw_vk_sampler_create(fdw_vk_context *context,
                      const fdw_vk_sampler_options *options);
FDW_VK_API void fdw_vk_sampler_destroy(fdw_vk_context *context,
                                       fdw_vk_sampler *sampler);
FDW_VK_API uint32_t fdw_vk_sampler_id(const fdw_vk_sampler *sampler);

// --- Shaders -----------------------------------------------------------------------

typedef struct fdw_vk_shader fdw_vk_shader;

// Compiles an entry point of an HLSL module to SPIR-V with the DXC library
// (loaded at the first call: FDW_DXC_LIBRARY, the Vulkan SDK, or the
// system), then creates its shader module. `arguments` are the DXC
// arguments (dxcArguments of the TypeScript side), `count` of them.
FDW_VK_API fdw_vk_shader *fdw_vk_shader_create(fdw_vk_context *context,
                                               const char *hlsl,
                                               const char *const *arguments,
                                               uint32_t count,
                                               const char *label);
FDW_VK_API void fdw_vk_shader_destroy(fdw_vk_context *context,
                                      fdw_vk_shader *shader);

// --- Groups of resources -------------------------------------------------------

typedef struct fdw_vk_group_layout fdw_vk_group_layout;
typedef struct fdw_vk_group fdw_vk_group;

typedef enum fdw_vk_binding_kind {
  FDW_VK_BINDING_UNIFORM = 0,
  FDW_VK_BINDING_TEXTURE = 1,
  FDW_VK_BINDING_SAMPLER = 2,
  FDW_VK_BINDING_STORAGE_READ = 3,
  FDW_VK_BINDING_STORAGE_READ_WRITE = 4,
} fdw_vk_binding_kind;

typedef struct fdw_vk_layout_binding {
  uint32_t binding;
  fdw_vk_binding_kind kind;
} fdw_vk_layout_binding;

// The layout of a group (a descriptor set layout), visible to every stage.
FDW_VK_API fdw_vk_group_layout *
fdw_vk_group_layout_create(fdw_vk_context *context,
                           const fdw_vk_layout_binding *bindings,
                           uint32_t count);
FDW_VK_API uint32_t fdw_vk_group_layout_id(const fdw_vk_group_layout *layout);

typedef struct fdw_vk_group_entry {
  uint32_t binding;
  // The id of a buffer, a texture or a sampler, as the layout says.
  uint32_t object;
} fdw_vk_group_entry;

// A group of resources (a descriptor set), for set_group commands.
FDW_VK_API fdw_vk_group *fdw_vk_group_create(fdw_vk_context *context,
                                             fdw_vk_group_layout *layout,
                                             const fdw_vk_group_entry *entries,
                                             uint32_t count);
FDW_VK_API void fdw_vk_group_destroy(fdw_vk_context *context,
                                     fdw_vk_group *group);
FDW_VK_API uint32_t fdw_vk_group_id(const fdw_vk_group *group);

// --- Pipelines ---------------------------------------------------------------------

typedef struct fdw_vk_pipeline fdw_vk_pipeline;

typedef struct fdw_vk_vertex_attribute {
  uint32_t location;
  // A vertex format of the engine: "float32x3", "unorm8x4"…
  const char *format;
  uint32_t offset;
} fdw_vk_vertex_attribute;

typedef struct fdw_vk_vertex_buffer {
  uint32_t stride;
  // 0: per vertex, 1: per instance.
  uint32_t per_instance;
  const fdw_vk_vertex_attribute *attributes;
  uint32_t attribute_count;
} fdw_vk_vertex_buffer;

typedef struct fdw_vk_blend_component {
  // "zero", "one", "src-alpha", "one-minus-src-alpha", "dst-alpha",
  // "one-minus-dst-alpha".
  const char *src_factor;
  const char *dst_factor;
  // "add", "subtract", "reverse-subtract", "min", "max".
  const char *operation;
} fdw_vk_blend_component;

typedef struct fdw_vk_color_target {
  const char *format;
  int32_t blend;
  fdw_vk_blend_component color;
  fdw_vk_blend_component alpha;
} fdw_vk_color_target;

typedef struct fdw_vk_render_pipeline_options {
  fdw_vk_shader *vertex;
  // NULL for depth-only pipelines without fragment work.
  fdw_vk_shader *fragment;
  // The layouts of the groups 0, 1… (NULL for an empty group).
  fdw_vk_group_layout *const *groups;
  uint32_t group_count;
  const fdw_vk_vertex_buffer *vertex_buffers;
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
  const fdw_vk_color_target *targets;
  uint32_t target_count;
  uint32_t sample_count;
  const char *label;
} fdw_vk_render_pipeline_options;

FDW_VK_API fdw_vk_pipeline *
fdw_vk_render_pipeline_create(fdw_vk_context *context,
                              const fdw_vk_render_pipeline_options *options);
// A compute pipeline: a compute shader and the layouts of its groups.
FDW_VK_API fdw_vk_pipeline *fdw_vk_compute_pipeline_create(
    fdw_vk_context *context, fdw_vk_shader *shader,
    fdw_vk_group_layout *const *groups, uint32_t group_count,
    const char *label);
FDW_VK_API void fdw_vk_pipeline_destroy(fdw_vk_context *context,
                                        fdw_vk_pipeline *pipeline);
FDW_VK_API uint32_t fdw_vk_pipeline_id(const fdw_vk_pipeline *pipeline);

// --- Swapchains --------------------------------------------------------------------

typedef struct fdw_vk_swapchain fdw_vk_swapchain;

// A native window, as fdw_window_native_handle of @fdw/engine-native gives
// it: system 1 X11 (Display*, Window), 2 Wayland (wl_display*,
// wl_surface*), 3 Win32 (HINSTANCE, HWND), 4 Cocoa (unsupported yet).
typedef struct fdw_vk_window_handle {
  int32_t system;
  uint64_t display;
  uint64_t window;
} fdw_vk_window_handle;

// A swapchain presenting into a window: FIFO (the vertical synchronization)
// with vsync, else mailbox or immediate. Returns NULL on error.
FDW_VK_API fdw_vk_swapchain *
fdw_vk_swapchain_create(fdw_vk_context *context,
                        const fdw_vk_window_handle *window, uint32_t width,
                        uint32_t height, int32_t vsync);
FDW_VK_API void fdw_vk_swapchain_destroy(fdw_vk_context *context,
                                         fdw_vk_swapchain *swapchain);
// The format of the images: "bgra8unorm" or "rgba8unorm".
FDW_VK_API const char *
fdw_vk_swapchain_format(const fdw_vk_swapchain *swapchain);
// Acquires the next image to render into; waits while two frames are in
// flight. Recreates the swapchain when the window size changed or it is out
// of date: `recreated` is then set, and the images are new. Returns the
// index of the image, or -1 on error.
FDW_VK_API int fdw_vk_swapchain_acquire(fdw_vk_context *context,
                                        fdw_vk_swapchain *swapchain,
                                        uint32_t width, uint32_t height,
                                        int32_t *recreated);
FDW_VK_API uint32_t
fdw_vk_swapchain_image_count(const fdw_vk_swapchain *swapchain);
// The size of the images, in pixels.
FDW_VK_API void fdw_vk_swapchain_extent(const fdw_vk_swapchain *swapchain,
                                        uint32_t *width, uint32_t *height);
// An image of the swapchain, as a texture of the commands (owned by the
// swapchain: fdw_vk_texture_destroy ignores it).
FDW_VK_API fdw_vk_texture *
fdw_vk_swapchain_image(const fdw_vk_swapchain *swapchain, uint32_t index);
// Presents the image acquired, after the commands submitted so far.
FDW_VK_API int fdw_vk_swapchain_present(fdw_vk_context *context,
                                        fdw_vk_swapchain *swapchain);

// --- Timestamps --------------------------------------------------------------------

// Timestamp queries, to measure the GPU duration of commands: written by
// FDW_VK_CMD_WRITE_TIMESTAMP, reset by FDW_VK_CMD_RESET_QUERIES, read
// without waiting.
typedef struct fdw_vk_query_pool fdw_vk_query_pool;

// Whether the queue of the context writes timestamps.
FDW_VK_API int fdw_vk_timestamps_supported(const fdw_vk_context *context);
// A pool of `count` timestamp queries; NULL on error (see
// fdw_vk_last_error).
FDW_VK_API fdw_vk_query_pool *fdw_vk_query_pool_create(fdw_vk_context *context,
                                                       uint32_t count);
// Destroyed once the GPU no longer uses it.
FDW_VK_API void fdw_vk_query_pool_destroy(fdw_vk_context *context,
                                          fdw_vk_query_pool *pool);
FDW_VK_API uint32_t fdw_vk_query_pool_id(const fdw_vk_query_pool *pool);
// The timestamps of queries [first, first + count), in nanoseconds, without
// waiting: returns 1 when all of them are available, 0 when some are not
// yet (`nanoseconds` is then unspecified), -1 on error.
FDW_VK_API int fdw_vk_query_pool_read(fdw_vk_context *context,
                                      fdw_vk_query_pool *pool, uint32_t first,
                                      uint32_t count, double *nanoseconds);

// --- Commands --------------------------------------------------------------------

// The commands of a submission: 32-bit words, each command an opcode then
// its operands; objects are given by id, floats by their bits, 64-bit
// values as two words (low, high).
enum {
  // colorCount, then per color: target, load (0 clear, 1 load), clear r, g,
  // b, a (floats), resolve target (0: none); then the depth target (0:
  // none), its load and its clear depth (float).
  FDW_VK_CMD_BEGIN_RENDER_PASS = 1,
  FDW_VK_CMD_END_RENDER_PASS = 2,
  // source, source offset (64), destination, destination offset (64),
  // size (64).
  FDW_VK_CMD_COPY_BUFFER = 3,
  // source, destination, width, height: from the top left corners.
  FDW_VK_CMD_COPY_TEXTURE = 4,
  // pipeline.
  FDW_VK_CMD_SET_PIPELINE = 5,
  // index, group.
  FDW_VK_CMD_SET_GROUP = 6,
  // slot, buffer.
  FDW_VK_CMD_SET_VERTEX_BUFFER = 7,
  // buffer, format (0: uint16, 1: uint32).
  FDW_VK_CMD_SET_INDEX_BUFFER = 8,
  // vertex count, instance count.
  FDW_VK_CMD_DRAW = 9,
  // index count, instance count.
  FDW_VK_CMD_DRAW_INDEXED = 10,
  // x, y, width, height (floats), in pixels from the top left corner.
  FDW_VK_CMD_SET_VIEWPORT = 11,
  // A compute pass: set_pipeline, set_group and dispatches until its end.
  FDW_VK_CMD_BEGIN_COMPUTE_PASS = 12,
  FDW_VK_CMD_END_COMPUTE_PASS = 13,
  // x, y, z workgroups.
  FDW_VK_CMD_DISPATCH = 14,
  // buffer (three u32: x, y, z), offset (64).
  FDW_VK_CMD_DISPATCH_INDIRECT = 15,
  // Outside of the passes. pool, first, count: before writing them again.
  FDW_VK_CMD_RESET_QUERIES = 16,
  // Outside of the passes. pool, index: the time when the commands before
  // are complete.
  FDW_VK_CMD_WRITE_TIMESTAMP = 17,
};

// Records the commands into a command buffer, with the barriers the
// resources need, and submits them after the pending writes.
FDW_VK_API int fdw_vk_submit(fdw_vk_context *context, const uint32_t *words,
                             size_t count);

#ifdef __cplusplus
}
#endif

#endif
