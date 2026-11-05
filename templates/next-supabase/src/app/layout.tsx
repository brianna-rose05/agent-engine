import { StudioBridge } from "@/lib/studio-bridge";

export const metadata = { title: "App" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StudioBridge />
        {children}
      </body>
    </html>
  );
}
