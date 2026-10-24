import { useState, type KeyboardEvent } from 'react';
import { Input } from '../components/ui/input';
import { useEditor, useSelector } from '../editorContext';
import type { LevelEdit, LevelProperties } from '../protocol';
import { PanelMessage } from '../views';

/**
 * A field written then validated (Enter, or leaving it); Escape gives the
 * value back. Shows the value of the level while it is not being written.
 */
function Field({
  value,
  label,
  onCommit,
  type = 'text',
}: {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (text: string) => void;
  readonly type?: 'text' | 'number';
}) {
  const [text, setText] = useState<string>();
  const commit = () => {
    if (text !== undefined && text !== value) onCommit(text);
    setText(undefined);
  };
  return (
    <Input
      size="xs"
      type={type}
      aria-label={label}
      value={text ?? value}
      step="any"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape') {
          setText(undefined);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const axes = ['X', 'Y', 'Z'] as const;

const vectors = [
  ['position', 'Position'],
  ['rotation', 'Rotation'],
  ['scale', 'Scale'],
] as const;

// A number as the fields show it.
const shown = (value: number) => String(Math.round(value * 1000) / 1000);

function Properties({ properties }: { readonly properties: LevelProperties }) {
  const { host } = useEditor();
  const { id } = properties;
  const edit = (edit: LevelEdit) =>
    host.engine.post({ type: 'level.command', command: 'edit', id, ...edit });
  return (
    <div className="grid grid-cols-[5rem_1fr] items-center gap-x-2 gap-y-1.5 p-3 text-xs">
      <span className="text-muted-foreground">Name</span>
      <Field
        label="Name"
        value={properties.name}
        onCommit={(value) => edit({ property: 'name', value })}
      />
      <span className="text-muted-foreground">Visible</span>
      <input
        type="checkbox"
        aria-label="Visible"
        className="size-3.5 justify-self-start"
        checked={properties.visible}
        onChange={(event) =>
          edit({ property: 'visible', value: event.target.checked })
        }
      />
      {vectors.map(([property, title]) => (
        <div key={property} className="contents">
          <span className="text-muted-foreground">{title}</span>
          <div className="grid grid-cols-3 gap-1">
            {axes.map((axis, index) => (
              <Field
                key={axis}
                type="number"
                label={`${title} ${axis}`}
                value={shown(properties[property][index])}
                onCommit={(text) => {
                  const value = [...properties[property]] as [
                    number,
                    number,
                    number,
                  ];
                  value[index] = Number(text);
                  if (Number.isFinite(value[index])) {
                    edit({ property, value });
                  }
                }}
              />
            ))}
          </div>
        </div>
      ))}
      {properties.components.map((component) => (
        <div key={component.name} className="contents">
          <span className="col-span-2 mt-2 border-t pt-2 font-medium">
            {component.name}
          </span>
          {component.fields?.map((field) => (
            <div key={field.name} className="contents">
              <span className="text-muted-foreground">{field.name}</span>
              <Field
                type="number"
                label={`${component.name} ${field.name}`}
                value={shown(field.value)}
                onCommit={(text) => {
                  const value = Number(text);
                  if (Number.isFinite(value)) {
                    edit({
                      property: 'field',
                      component: component.name,
                      field: field.name,
                      value,
                    });
                  }
                }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The properties of the active node of the level: its name, its
 * visibility, its transform (the rotation in degrees), its components and
 * the numbers of those saved field by field. A field validated is a
 * command of the level, undone with the others.
 */
export function InspectorPanel() {
  const { level } = useEditor();
  const properties = useSelector(
    level,
    (snapshot) => snapshot.context.properties,
  );
  if (!properties) return <PanelMessage text="Nothing selected." />;
  // Fields of another node: started again.
  return (
    <div className="h-full overflow-auto">
      <Properties key={properties.id} properties={properties} />
    </div>
  );
}
