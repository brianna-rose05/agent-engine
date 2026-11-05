import Link from "next/link";
import { getActor } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActor();
  return (
    <main style={{ padding: "2rem" }}>
      <h1 style={{ color: "#1f6f5c" }}>Pawfect grooming</h1>
      {actor ? <Link href="/book">Book a time</Link> : <Link href="/sign-up">Create an account</Link>}
    </main>
  );
}
