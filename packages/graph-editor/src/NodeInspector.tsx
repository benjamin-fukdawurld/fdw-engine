import { Input, NativeSelect, NativeSelectOption } from '@fdw/editor-ui';
import { formatDiagnostic } from '@fdw/engine-graph';
import type {
  GraphCommand,
  GraphView,
  NodeView,
  ParamView,
  PortView,
} from '@fdw/engine-graph-editing';
import { type KeyboardEvent, useState } from 'react';

/**
 * A field written then validated (Enter, or leaving it); Escape gives the
 * value back. Shows the value of the graph while it is not being written.
 */
export function Field({
  value,
  label,
  onCommit,
  type = 'text',
  multiline = false,
}: {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (text: string) => void;
  readonly type?: 'text' | 'number';
  readonly multiline?: boolean;
}) {
  const [text, setText] = useState<string>();
  const commit = () => {
    if (text !== undefined && text !== value) onCommit(text);
    setText(undefined);
  };
  const keyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      setText(undefined);
      event.currentTarget.blur();
    }
  };
  if (multiline) {
    return (
      <textarea
        aria-label={label}
        rows={3}
        className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={text ?? value}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={keyDown}
      />
    );
  }
  return (
    <Input
      size="xs"
      type={type}
      step="any"
      aria-label={label}
      value={text ?? value}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={keyDown}
    />
  );
}

const json = (value: unknown) =>
  value === undefined ? '' : JSON.stringify(value);

// Reads a JSON value; undefined (and a warning) when it is not one.
function readJson(text: string): { value?: unknown; error?: string } {
  if (text.trim() === '') return {};
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `Not JSON: ${text}` };
  }
}

/** The editor of a value, by its kind or its type. */
function ValueField({
  label,
  kind,
  values,
  value,
  onChange,
  onError,
}: {
  readonly label: string;
  /** A kind of parameter, or the type of a port. */
  readonly kind: string;
  readonly values?: readonly string[];
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly onError: (message: string) => void;
}) {
  if (values) {
    return (
      <NativeSelect
        size="xs"
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {typeof value !== 'string' && <NativeSelectOption value="" />}
        {values.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    );
  }
  switch (kind) {
    case 'boolean':
    case 'bool':
      return (
        <input
          type="checkbox"
          aria-label={label}
          className="size-3.5 justify-self-start"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case 'number':
    case 'f32':
    case 'i32':
    case 'u32':
    case 'entity':
      return (
        <Field
          type="number"
          label={label}
          value={typeof value === 'number' ? String(value) : ''}
          onCommit={(text) => {
            const number = Number(text);
            if (text.trim() !== '' && Number.isFinite(number)) onChange(number);
            else onError(`Not a number: ${text}`);
          }}
        />
      );
    case 'string':
      return (
        <Field
          label={label}
          value={typeof value === 'string' ? value : ''}
          onCommit={onChange}
        />
      );
  }
  // A vector: its components side by side.
  const size = /^vec([234])</.exec(kind)?.[1];
  const components =
    kind === 'vec3'
      ? ['x', 'y', 'z']
      : size
        ? ['x', 'y', 'z', 'w'].slice(0, Number(size))
        : undefined;
  if (components) {
    const current = components.map((axis, i) =>
      Array.isArray(value)
        ? (value[i] as number)
        : typeof value === 'object' && value !== null
          ? (value as Record<string, number>)[axis]
          : typeof value === 'number'
            ? value
            : 0,
    );
    return (
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${components.length}, 1fr)` }}
      >
        {components.map((axis, i) => (
          <Field
            key={axis}
            type="number"
            label={`${label} ${axis}`}
            value={String(current[i] ?? 0)}
            onCommit={(text) => {
              const number = Number(text);
              if (!Number.isFinite(number))
                return onError(`Not a number: ${text}`);
              const next = [...current];
              next[i] = number;
              onChange(
                kind === 'vec3'
                  ? Object.fromEntries(
                      components.map((a, j) => [a, next[j] ?? 0]),
                    )
                  : next,
              );
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <Field
      multiline={kind === 'json'}
      label={label}
      value={json(value)}
      onCommit={(text) => {
        const read = readJson(text);
        if (read.error) onError(read.error);
        else onChange(read.value);
      }}
    />
  );
}

/**
 * The node selected: its label, its parameters, the values of its inputs
 * not connected, its problems. Each value validated is a command of the
 * graph, undone with the others.
 */
export function NodeInspector({
  view,
  node,
  dispatch,
  onError,
  hiddenParams = [],
}: {
  readonly view: GraphView;
  readonly node: NodeView;
  readonly dispatch: (command: GraphCommand) => void;
  readonly onError: (message: string) => void;
  /** Parameters another panel edits (the states of a state machine). */
  readonly hiddenParams?: readonly string[];
}) {
  const connected = new Set(
    view.edges
      .filter((edge) => edge.to.node === node.id)
      .map((edge) => edge.to.port),
  );
  const inputs = node.inputs.filter(
    (port: PortView) => !port.exec && !connected.has(port.name),
  );
  const schema = node.schema.filter(
    (param: ParamView) => !hiddenParams.includes(param.name),
  );
  const problems = view.diagnostics.filter((d) => d.node === node.id);
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1.5 p-3 text-xs">
      <span className="col-span-2 font-medium">{node.title}</span>
      <span className="col-span-2 -mt-1 text-muted-foreground">
        #{node.id} · {node.type}
      </span>
      {node.description && (
        <p className="col-span-2 text-muted-foreground">{node.description}</p>
      )}
      <span className="text-muted-foreground">Label</span>
      <Field
        label="Label"
        value={node.label ?? ''}
        onCommit={(label) =>
          dispatch({
            op: 'label',
            node: node.id,
            ...(label !== '' && { label }),
          })
        }
      />
      {schema.length > 0 && (
        <span className="col-span-2 mt-2 border-t pt-2 font-medium">
          Parameters
        </span>
      )}
      {schema.map((param) => (
        <div key={param.name} className="contents">
          <span
            className="truncate text-muted-foreground"
            title={param.description ?? param.name}
          >
            {param.name}
            {param.required && ' *'}
          </span>
          <ValueField
            label={param.name}
            kind={param.kind}
            {...(param.values && { values: param.values })}
            value={node.params[param.name] ?? param.default}
            onChange={(value) =>
              dispatch({
                op: 'params',
                node: node.id,
                params: { [param.name]: value },
              })
            }
            onError={onError}
          />
        </div>
      ))}
      {inputs.length > 0 && (
        <span className="col-span-2 mt-2 border-t pt-2 font-medium">
          Inputs
        </span>
      )}
      {inputs.map((port) => (
        <div key={port.name} className="contents">
          <span className="truncate text-muted-foreground" title={port.type}>
            {port.name}
          </span>
          <ValueField
            label={`${port.name} value`}
            kind={port.type}
            value={node.defaults?.[port.name] ?? port.default}
            onChange={(value) =>
              dispatch({
                op: 'default',
                node: node.id,
                port: port.name,
                value,
              })
            }
            onError={onError}
          />
        </div>
      ))}
      {problems.length > 0 && (
        <ul className="col-span-2 mt-2 space-y-1 border-t pt-2">
          {problems.map((problem, i) => (
            <li
              key={i}
              className={
                problem.severity === 'error'
                  ? 'text-destructive'
                  : 'text-amber-500'
              }
            >
              {formatDiagnostic({ ...problem, node: undefined })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
