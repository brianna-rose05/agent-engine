import type { Slot } from "@/contracts/types";

export function SlotPicker(props: {
  slots: Slot[];
  tz: string;
  selectedId?: string;
  onPick: (slotId: string) => void;
}): React.JSX.Element {
  if (!props.slots.length) return <p>No open times this day</p>;
  const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: props.tz });
  return (
    <div role="group" aria-label="Open times">
      {props.slots.map((s) => (
        <button key={s.id} type="button" aria-pressed={s.id === props.selectedId} onClick={() => props.onPick(s.id)}>
          {fmt.format(s.startsAt)}
        </button>
      ))}
    </div>
  );
}
