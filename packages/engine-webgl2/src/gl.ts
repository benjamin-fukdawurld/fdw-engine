// The WebGL2 constants. WebGL2RenderingContext only exists in browsers: it is
// read on first use, so that the package can be loaded elsewhere (code
// generation in Node, tests).
export const GL = new Proxy({} as typeof WebGL2RenderingContext, {
  get(_, name) {
    const context = (
      globalThis as { WebGL2RenderingContext?: typeof WebGL2RenderingContext }
    ).WebGL2RenderingContext;
    if (!context) {
      throw new Error('WebGL2 is not supported in this environment');
    }
    return context[name as keyof typeof WebGL2RenderingContext];
  },
});

// A value computed on first use: tables of constants cannot be built when
// the module is loaded.
export function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= create());
}
