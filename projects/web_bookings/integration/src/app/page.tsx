import Link from "next/link";
import { getActor } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActor();
  return (
    <main>
      <h1>Pet grooming</h1>
      {actor ? <Link href="/book">Book a time</Link> : <Link href="/sign-up">Create an account</Link>}
    </main>
  );
}
