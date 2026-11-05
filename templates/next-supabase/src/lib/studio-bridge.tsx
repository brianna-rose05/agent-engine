"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Template file: do not edit. Rendered once in the root layout (src/app/layout.tsx).
 *
 * When this app is shown inside Studio's preview (an iframe), it tells Studio which page is open, so the owner's
 * comment pins land on the right page. It posts `{ type: "studio:path", path }` (the pathname only: no query
 * string, no data, no cookies) to the parent window on load and after each client navigation, and does nothing at
 * all when the app is not framed. Studio accepts the message only from the preview's own origin.
 */
export function StudioBridge(): null {
  const path = usePathname();
  useEffect(() => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "studio:path", path: window.location.pathname }, "*");
  }, [path]);
  return null;
}
