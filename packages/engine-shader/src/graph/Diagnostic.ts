import type { NodeId } from './MaterialGraphData';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly node?: NodeId;
  readonly port?: string;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.node
    ? diagnostic.port
      ? `#${diagnostic.node}.${diagnostic.port}: `
      : `#${diagnostic.node}: `
    : '';
  return `${diagnostic.severity}: ${location}${diagnostic.message}`;
}

export class GraphError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'GraphError';
    this.diagnostics = diagnostics;
  }
}
