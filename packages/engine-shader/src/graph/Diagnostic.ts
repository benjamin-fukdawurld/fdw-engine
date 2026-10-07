import type { NodeId } from './MaterialGraphData';

/**
 * Errors prevent the compilation; warnings do not.
 *
 * @group Validation
 */
export type DiagnosticSeverity = 'error' | 'warning';

/**
 * A problem found in a graph, located by node and port when possible.
 *
 * @group Validation
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** The node in cause. */
  readonly node?: NodeId;
  /** The port in cause. */
  readonly port?: string;
}

/**
 * One-line representation: `error: #n3.b: std.mul: got vec4<f32>…`.
 *
 * @group Validation
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.node
    ? diagnostic.port
      ? `#${diagnostic.node}.${diagnostic.port}: `
      : `#${diagnostic.node}: `
    : '';
  return `${diagnostic.severity}: ${location}${diagnostic.message}`;
}

/**
 * Thrown by {@link GraphBuilder}, {@link compile}… when a graph has errors.
 * Its message lists them, one per line.
 *
 * @group Validation
 */
export class GraphError extends Error {
  /** The errors, as structured data. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'GraphError';
    this.diagnostics = diagnostics;
  }
}
