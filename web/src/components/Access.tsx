"use client";

import { Eye } from "lucide-react";
import { ASK_FOR_EDIT, OWNER_ONLY, useAccess } from "@/lib/convex";

/*
 * What a signed-in person may do (docs/accounts.md), on the screen. The backend checks every call itself; this only
 * keeps viewers (and editors, for owner-only settings) from pressing buttons that would be refused.
 */

/** Disables every button and field inside for people without the role. `contents`: adds no box to the layout. */
export function EditGate({ children, owner = false }: { children: React.ReactNode; owner?: boolean }) {
  const me = useAccess();
  const ok = owner ? me.isOwner : me.canEdit;
  return (
    <fieldset disabled={!ok} className="contents">
      {children}
    </fieldset>
  );
}

/** "Ask the owner for edit access." next to disabled actions; nothing for people who may act. */
export function ViewOnlyNote({ owner = false, className = "" }: { owner?: boolean; className?: string }) {
  const me = useAccess();
  if (owner ? me.isOwner : me.canEdit) return null;
  return <p className={`text-xs text-muted ${className}`}>{owner ? OWNER_ONLY : ASK_FOR_EDIT}.</p>;
}

/** The banner on a project for viewers: they can look around, nothing more. */
export function ViewOnlyBanner() {
  const me = useAccess();
  if (me.canEdit) return null;
  return (
    <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-muted md:px-6">
      <Eye size={14} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span>
        You have view access, so actions are turned off. {ASK_FOR_EDIT} to approve plans, ask for changes or ship.
      </span>
    </div>
  );
}
