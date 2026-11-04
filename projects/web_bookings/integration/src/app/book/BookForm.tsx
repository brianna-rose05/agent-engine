"use client";

import { useState } from "react";
import type { Slot } from "@/contracts/types";
import { SlotPicker } from "@/components/SlotPicker";
import { book } from "./actions";

export function BookForm({ slots, tz }: { slots: Slot[]; tz: string }) {
  const [slotId, setSlotId] = useState<string>();
  const [pet, setPet] = useState("");
  const [message, setMessage] = useState("");
  return (
    <div>
      <SlotPicker slots={slots} tz={tz} selectedId={slotId} onPick={setSlotId} />
      <input value={pet} onChange={(e) => setPet(e.target.value)} aria-label="Pet name" />
      <button disabled={!slotId || !pet} onClick={async () => setMessage(await book(slotId!, pet))}>Book</button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
