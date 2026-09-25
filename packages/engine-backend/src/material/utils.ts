import { MaterialBindingSlot, MaterialBindingSlotNames } from './types';

export function getMaterialBindingSlotOrder(
  slots: MaterialBindingSlot[]
): MaterialBindingSlot[] {
  return [
    ...MaterialBindingSlotNames,
    ...slots
      .filter((current) => !MaterialBindingSlotNames.includes(current as any))
      .sort(),
  ];
}
