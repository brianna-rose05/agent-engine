"use client";

import { useActionState } from "react";
import { claim } from "./actions";

export function ClaimForm() {
  const [error, action, pending] = useActionState(claim, "");
  return (
    <form action={action}>
      <input name="code" aria-label="Setup code" />
      {error && <p role="alert">{error}</p>}
      <button disabled={pending}>Claim owner</button>
    </form>
  );
}
