import Link from "next/link";
import { ownerSetupState } from "@/lib/owner";
import { getDb } from "@/lib/runtime";
import { getActor } from "@/lib/session";
import { ClaimForm } from "./ClaimForm";

export const dynamic = "force-dynamic";

export default async function OwnerSetup() {
  const state = await ownerSetupState(await getDb());
  if (state === "claimed") return <main><p>This app already has an owner.</p><Link href="/">Home</Link></main>;
  if (state === "not_configured") return <main><p>Owner setup isn&apos;t configured for this app.</p></main>;
  const actor = await getActor();
  return (
    <main>
      <h1>Set up the owner account</h1>
      {actor ? <ClaimForm /> : <Link href="/sign-up">Create an account first</Link>}
    </main>
  );
}
