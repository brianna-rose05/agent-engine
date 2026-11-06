/**
 * What the sign-in gate shows. "wait" while the saved sign-in is being read or checked, so a page load never flashes
 * the sign-in form. Regression (Nov 6): every page load showed "Sign in" for a moment, which looked like being
 * signed out. A key the person just typed (not the restored one) shows the form, which says it's checking.
 */
export function gateView(s: {
  ready: boolean;
  state: "none" | "checking" | "ok" | "wrong";
  key: string | null;
  restored: string | null;
}): "app" | "wait" | "form" {
  if (s.state === "ok") return "app";
  if (!s.ready) return "wait";
  if (s.state === "checking" && s.key !== null && s.key === s.restored) return "wait";
  return "form";
}
