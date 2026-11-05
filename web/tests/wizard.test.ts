import { describe, expect, it } from "vitest";
import {
  CHECKLIST, DESIGN_RULES, OWNER_RULE, checkQuestions, checkRequirements, composeSpec, designWarnings, type Design, type Feature,
  type Question, type Wizard,
} from "../convex/wizard";

const q = (id: string, item: string, gate: "must" | "confirm" = "must"): Question => ({
  id, item, gate, question: `About ${item}?`, recommended: 0, reason: "safe default",
  options: [{ label: "Yes", changes: "adds it" }, { label: "No", changes: "skips it" }],
});
const asked = ["users_roles", "payments", "sensitive_data", "platform"].map((item, i) => q(`q${i + 1}`, item));
const rest = CHECKLIST.filter((c) => !asked.some((x) => x.item === c.item)).map((c) => ({ item: c.item, text: "assumed" }));

describe("checkQuestions", () => {
  it("accepts full coverage", () => {
    expect(checkQuestions({ answered_by_brief: [], questions: asked, assumptions: rest })).toEqual([]);
  });
  it("rejects a must item turned into an assumption", () => {
    const p = checkQuestions({ answered_by_brief: [], questions: asked.slice(1),
                               assumptions: [...rest, { item: "users_roles", text: "x" }] });
    expect(p.join()).toContain("users_roles is a must-answer item");
  });
  it("lets the brief answer a must item", () => {
    const p = checkQuestions({ answered_by_brief: [{ item: "payments", answer: "no payments" }],
                               questions: [...asked.filter((x) => x.item !== "payments"), q("q9", "core_flows", "confirm")],
                               assumptions: rest });
    expect(p).toEqual([]);
  });
  it("flags demotion, bad option counts and uncovered items", () => {
    const bad = [{ ...asked[0], gate: "confirm" as const }, { ...asked[1], options: [asked[1].options[0]] }, ...asked.slice(2)];
    const p = checkQuestions({ answered_by_brief: [], questions: bad, assumptions: [] }).join("\n");
    expect(p).toContain("can't be demoted");
    expect(p).toContain("2 to 4 options");
    expect(p).toContain("language is not covered");
  });
});

const feats: Feature[] = [{ id: "F1", name: "Booking", summary: "", stories: [
  { id: "S1", text: "A customer can book", criteria: ["A booking at 10:00 shows on the list", "Double booking returns SLOT_TAKEN"], priority: "must" },
  { id: "S2", text: "A customer can review", criteria: [], priority: "out" },
] }];

describe("checkRequirements", () => {
  it("accepts checkable stories", () => expect(checkRequirements({ features: feats })).toEqual([]));
  it("rejects vague criteria, missing criteria and no musts", () => {
    const p = checkRequirements({ features: [{ ...feats[0], stories: [
      { id: "S1", text: "x", criteria: ["Booking is fast", "ok"], priority: "should" },
      { id: "S2", text: "y", criteria: ["one"], priority: "could" }] }] }).join("\n");
    expect(p).toContain("not checkable");
    expect(p).toContain("story S2 needs 2 to 5");
    expect(p).toContain("at least one story must be a Must");
  });
});

const design: Design = {
  tables: [{ name: "bookings", purpose: "", fields: [], security: ["Customers see only their own bookings"] }],
  pages: [{ id: "P1", name: "Book", route: "/book", purpose: "", stories: ["S1"], tables: ["bookings"], actions: ["A1"] }],
  flows: [], actions: [{ id: "A1", who: "Customers", sentence: "book a slot", kind: "write", page: "P1" }],
  looks: [{ id: "L1", name: "Calm", description: "", palette: [{ name: "bg", hex: "#fff" }], font: "Inter", radius: "8px" }],
};

describe("designWarnings", () => {
  it("passes a complete design", () => expect(designWarnings(design, feats)).toEqual([]));
  it("flags unmapped musts, missing tables and missing security", () => {
    const d = { ...design, tables: [{ ...design.tables[0], security: [] }],
                pages: [{ ...design.pages[0], stories: [], tables: ["payments"] }] };
    const w = designWarnings(d, feats).join("\n");
    expect(w).toContain("Must story S1 isn't on any page");
    expect(w).toContain('"payments" that doesn\'t exist');
    expect(w).toContain("bookings has no security rule");
  });
});

describe("owner rule (Design step)", () => {
  it("the design prompt says the owner is the admin and claims it on /owner-setup", () => {
    expect(DESIGN_RULES).toContain(OWNER_RULE);
    expect(OWNER_RULE).toContain("The app's owner is its admin");
    expect(OWNER_RULE).toContain("/owner-setup");
    expect(OWNER_RULE).toContain("src/lib/owner.ts");
    expect(OWNER_RULE).toContain("granted by the owner in the app");
  });
  const withText = (security: string, why = "who the person is") => ({
    ...design,
    tables: [{ ...design.tables[0], security: [security], fields: [{ name: "role", type: "text", why }] }],
  });
  it("refuses roles set by hand in the database", () => {
    for (const bad of [
      "The admin role is set by the project owner directly in the database.",
      "Admins are added manually in the database",
      "The owner sets a member as admin by hand",
      "Roles can only be changed by hand; signed-in requests can't change them",
    ]) {
      const w = designWarnings(withText(bad), feats).join("\n");
      expect(w, bad).toContain("says a role is set by hand in the database");
      expect(w).toContain("/owner-setup");
    }
    const w = designWarnings(withText("Members see their own loans", "admin flag, flipped directly in the database"), feats);
    expect(w.join("\n")).toContain("field bookings.role says a role is set by hand");
  });
  it("accepts ordinary rules that mention the database or roles", () => {
    for (const ok of [
      "Customers see only their own bookings",
      "Each person's role is stored in the database",
      "Staff can update any booking in the database",
      "Only the owner (isOwner) can change staff roles, in the app",
    ]) {
      expect(designWarnings(withText(ok), feats), ok).toEqual([]);
    }
  });
});

describe("composeSpec", () => {
  it("is the plain description until design is locked", () => {
    expect(composeSpec("X", "desc", { step: "design" })).toBe("desc");
  });
  it("includes decisions, Must stories with tests, data, actions and look, but not Out stories", () => {
    const w: Wizard = { step: "team", locked: { design: true }, questions: [asked[0]], answers: { q1: { option: 1 } },
                        requirements: { features: feats, assumptions: [] }, design, look: "L1" };
    const s = composeSpec("Groomer", "A grooming app", w);
    expect(s).toContain("About users_roles? -> No");
    expect(s).toContain("[MUST] S1: A customer can book");
    expect(s).toContain("  - Test: Double booking returns SLOT_TAKEN");
    expect(s).not.toContain("A customer can review");
    expect(s).toContain("Security: Customers see only their own bookings");
    expect(s).toContain("A1 [write] Customers: book a slot");
    expect(s).toContain("## Look and feel: Calm");
  });
});
