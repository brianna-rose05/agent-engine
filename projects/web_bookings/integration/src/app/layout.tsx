import Link from "next/link";
import { StudioBridge } from "@/lib/studio-bridge";

export const metadata = { title: "Pet grooming" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StudioBridge />
        <header>
          <Link href="/">Pet grooming</Link> <Link href="/book">Book</Link>
        </header>
        {children}
      </body>
    </html>
  );
}
