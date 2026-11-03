import type { Slot } from "@/contracts/types";

/**
 * One button per slot, in the order given, labelled with the start time in `tz` like "9:00 AM".
 * Clicking a button calls onPick(slot.id). The button for `selectedId` has aria-pressed="true".
 * With no slots, shows the text "No open times this day".
 */
export function SlotPicker(props: {
  slots: Slot[];
  tz: string;
  selectedId?: string;
  onPick: (slotId: string) => void;
}): React.JSX.Element {
  throw new Error("Not implemented");
}
