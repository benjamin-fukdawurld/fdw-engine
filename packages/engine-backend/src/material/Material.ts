import { CachedValue, SnapshotProvider, SnapshotValue } from '../utils';
import type {
  MaterialBinding,
  MaterialBindingShape,
  MaterialDescription,
  MaterialUniformBindingShape,
} from './types';

export class Material implements MaterialDescription {
  readonly label?: string;
  readonly shadingModel: string;
  private _bindings: MaterialBinding[];

  private _shapeKey: CachedValue<
    string,
    [SnapshotProvider<MaterialBindingShape[]>]
  >;
  private _shapeVersion: number;
  private readonly _shape: SnapshotProvider<MaterialBindingShape[]>;

  constructor({ label, shape, shadingModel }: MaterialDescription) {
    this.label = label;
    this.shadingModel = shadingModel;
    this._bindings = [...bindings];
    this._shapeVersion = 0;

    this._shape = new SnapshotValue<MaterialBindingShape[]>({
      valueGetter: () =>
        this._bindings.map((binding) => {
          if (binding.kind === 'texture') {
            const { texture, sampler, ...shape } = binding;
            void texture;
            void sampler;
            return shape;
          }

          const { value, ...shape } = binding;
          void value;
          return shape;
        }),
      versionGetter: () => this._shapeVersion,
    });

    this._shapeKey = new CachedValue<
      string,
      [SnapshotProvider<MaterialBindingShape[]>]
    >({
      initialValue: '',
      updateStrategy: (_, dependencies) => {
        return Material.getShapeKey(dependencies[0].value);
      },
      dependencies: [this._shape],
    });
  }

  setBinding(binding: MaterialBinding): this {
    const existingIndex = this._bindings.findIndex(
      (b) => b.name === binding.name
    );
    const existing =
      existingIndex !== -1 ? this._bindings[existingIndex] : undefined;
    const isStructural =
      !existing ||
      existing.kind !== binding.kind ||
      (binding.kind !== 'texture' &&
        (existing as MaterialUniformBindingShape).type !== binding.type) ||
      existing.slot !== binding.slot;

    if (isStructural) {
      this._shapeVersion++;
    }

    if (existing) {
      this._bindings[existingIndex] = binding;
    } else {
      this._bindings.push(binding);
    }

    return this;
  }

  removeBinding(bindingName: string): this {
    const existingIndex = this._bindings.findIndex(
      (b) => b.name === bindingName
    );
    if (existingIndex == -1) {
      return this;
    }

    this._shapeVersion++;
    this._bindings.splice(existingIndex, 1);

    return this;
  }

  clearBindings(): this {
    this._shapeVersion++;
    this._bindings = [];
    return this;
  }

  get bindings(): Readonly<MaterialBinding[]> {
    return this._bindings;
  }

  get shape(): MaterialBindingShape[] {
    return this._shape.value;
  }

  get shapeKey(): string {
    return this._shapeKey.value;
  }

  private static stringifyBindingShape(shape: MaterialBindingShape): string {
    if (shape.kind === 'texture') {
      const { kind, name, slot, type, format } = shape;
      return [kind, name, slot, type, format].join('-');
    }

    const { kind, name, slot, type } = shape;
    return [kind, name, slot, type].join('-');
  }

  private static getShapeKey(shape: MaterialBindingShape[]): string {
    return shape.map(Material.stringifyBindingShape).join(':');
  }
}

export default Material;
