import { getDb } from "@/lib/runtime";
import { requireActor } from "@/lib/session";
import { listOpenSlots } from "@/server/slots";
import { BookForm } from "./BookForm";

export const dynamic = "force-dynamic";
const TZ = "America/Los_Angeles";

export default async function BookPage() {
  await requireActor("/sign-up");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const slots = await listOpenSlots(await getDb(), today, TZ);
  return (
    <main>
      <h1>Book a time</h1>
      <BookForm slots={slots} tz={TZ} />
    </main>
  );
}
