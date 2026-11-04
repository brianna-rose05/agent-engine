/*
 * Change requests (docs/change-requests.md): the rules both Convex (projects.requestChange) and the app use.
 * Pure functions only, so the app and the tests can import them without a Convex backend.
 */

export const CHANGE_TEXT_MIN = 10;
export const CHANGE_TEXT_MAX = 4000;

/** One request in the project's history, as stored on the project row. `at` is milliseconds since epoch. */
export type ChangeRequest = { n: number; text: string; at: number };

/**
 * Whether the owner can ask for a change now: the project was built (done) or stopped after planning
 * (failed with a plan), and nothing is running. Convex also requires the repo; the app trusts Convex for that.
 */
export function canRequestChange(status: string, hasPlan: boolean, running: boolean): boolean {
  if (running) return false;
  return status === "done" || (status === "failed" && hasPlan);
}

/** The request text, trimmed, or the message to show the owner when it can't be used. */
export function checkChangeText(text: string): { ok: true; text: string } | { ok: false; message: string } {
  const t = text.trim();
  if (t.length < CHANGE_TEXT_MIN) {
    return { ok: false, message: "Describe the change in a sentence or two, so the planner knows what to do." };
  }
  if (t.length > CHANGE_TEXT_MAX) {
    return { ok: false, message: `Keep the change under ${CHANGE_TEXT_MAX} characters. Split a bigger one into several requests.` };
  }
  return { ok: true, text: t };
}

/** The next change number: 1, 2, ... */
export const nextChangeNumber = (changes: ChangeRequest[] | undefined) =>
  (changes ?? []).reduce((m, c) => Math.max(m, c.n), 0) + 1;
