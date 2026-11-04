"use client";

import { useActionState } from "react";
import { signUp } from "./actions";

export default function SignUpPage() {
  const [error, action, pending] = useActionState(signUp, "");
  return (
    <form action={action}>
      <input name="name" aria-label="Name" />
      <input name="email" aria-label="Email" />
      <input name="password" type="password" aria-label="Password" />
      {error && <p role="alert">{error}</p>}
      <button disabled={pending}>Create account</button>
    </form>
  );
}
