import { type GenericActionCtx, actionGeneric, anyApi, internalMutationGeneric, internalQueryGeneric, mutationGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import { callChecked, type JsonSchema } from "./ai";
import { requireRole, requireRoleInAction } from "./owner";

/*
 * The setup wizard (spec: Describe -> Questions -> Requirements -> Stack -> Design -> Team plan).
 * The AI drafts every step; the user approves, comments or tweaks. Code (not the AI) enforces the spec's rules
 * before a step can lock. Team plan is the engine's own plan, made from everything locked here.
 */

// ------------------------------------------------------------------ types
export type Gate = "must" | "confirm";
export type Question = {
  id: string; item: string; gate: Gate; question: string;
  options: { label: string; changes: string }[]; recommended: number; reason: string;
};
export type Answer = { option?: number; other?: string };
export type Priority = "must" | "should" | "could" | "out";
export type Story = { id: string; text: string; criteria: string[]; priority: Priority };
export type Feature = { id: string; name: string; summary: string; stories: Story[] };
export type Table = { name: string; purpose: string; fields: { name: string; type: string; why: string }[];
                      security: string[] };
export type Page = { id: string; name: string; route: string; purpose: string; stories: string[]; tables: string[];
                     actions: string[] };
export type Action = { id: string; who: string; sentence: string; kind: "read" | "write"; page: string };
export type Look = { id: string; name: string; description: string; palette: { name: string; hex: string }[];
                     font: string; radius: string };
export type Design = { tables: Table[]; pages: Page[]; flows: { name: string; steps: string[] }[]; actions: Action[];
                       looks: Look[] };
export type Wizard = {
  step: "questions" | "requirements" | "stack" | "design" | "team";
  busy?: string | null;
  error?: string | null;
  questions?: Question[];
  assumptions?: { item: string; text: string }[];
  answers?: Record<string, Answer>;
  requirements?: { features: Feature[]; assumptions: string[] };
  stack?: { summary: string; layers: { layer: string; choice: string; tier: string; reason: string;
                                      alternatives: { name: string; tier: string; note: string }[] }[] };
  design?: Design;
  look?: string;
  changed?: string[];
  locked?: Partial<Record<"questions" | "requirements" | "stack" | "design", boolean>>;
};

// ------------------------------------------------------- decision checklist
/** Fixed coverage, written by the product team (spec). The AI writes the questions; it may promote an item
 * to a stricter gate when the brief makes it risky, never demote one. */
export const CHECKLIST: { item: string; gate: Gate | "assume"; about: string }[] = [
  { item: "users_roles", gate: "must", about: "Who signs in (customers, staff, both, nobody)" },
  { item: "payments", gate: "must", about: "Whether the app takes money, and how" },
  { item: "sensitive_data", gate: "must", about: "Whether it stores personal or sensitive data" },
  { item: "platform", gate: "must", about: "Mobile-friendly website or native app" },
  { item: "core_flows", gate: "confirm", about: "Key flows the brief leaves open (cancel, edit, approve...)" },
  { item: "data_relationships", gate: "confirm", about: "One-to-many questions (e.g. several pets per customer)" },
  { item: "notifications", gate: "confirm", about: "Email, text, both or none" },
  { item: "integrations", gate: "confirm", about: "Outside services (calendars, maps, payments providers)" },
  { item: "scale", gate: "assume", about: "One location / organization or several" },
  { item: "language", gate: "assume", about: "Languages supported" },
  { item: "auth_rules", gate: "assume", about: "Password and account rules" },
];

const SYSTEM = `You are the planner in an app where AI agents build software for people who approve, not author.
Write in plain language a non-developer understands. Be specific and checkable. Never invent requirements the
brief and answers don't support.`;

// ------------------------------------------------------------- helpers
async function getProject(ctx: GenericActionCtx<any>, id: string) {  // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await ctx.runQuery(anyApi.wizard.load, { id })) as { name: string; description: string; wizard: Wizard };
}

const str = { type: "string" } as const;
const strArr = { type: "array", items: str } as const;

// --------------------------------------------------------------- step 2: questions
const QUESTION_SCHEMA: JsonSchema = {
  type: "object", required: ["answered_by_brief", "questions", "assumptions"],
  properties: {
    answered_by_brief: { type: "array", items: { type: "object", required: ["item", "answer"],
      properties: { item: str, answer: str } } },
    questions: { type: "array", items: { type: "object",
      required: ["id", "item", "gate", "question", "options", "recommended", "reason"],
      properties: { id: str, item: str, gate: { type: "string", enum: ["must", "confirm"] }, question: str,
        options: { type: "array", items: { type: "object", required: ["label", "changes"],
          properties: { label: str, changes: str } } },
        recommended: { type: "integer" }, reason: str } } },
    assumptions: { type: "array", items: { type: "object", required: ["item", "text"],
      properties: { item: str, text: str } } },
  },
};

type QuestionResult = { answered_by_brief: { item: string; answer: string }[]; questions: Question[];
                        assumptions: { item: string; text: string }[] };

export function checkQuestions(r: QuestionResult): string[] {
  const p: string[] = [];
  if (r.questions.length < 3 || r.questions.length > 8) p.push(`ask 3 to 8 questions (you asked ${r.questions.length})`);
  const covered = new Set([...r.answered_by_brief.map((a) => a.item), ...r.questions.map((q) => q.item),
                           ...r.assumptions.map((a) => a.item)]);
  for (const c of CHECKLIST) if (!covered.has(c.item)) p.push(`checklist item ${c.item} is not covered`);
  const asked = new Set(r.questions.map((q) => q.item));
  const briefed = new Set(r.answered_by_brief.map((a) => a.item));
  for (const c of CHECKLIST) {
    if (c.gate === "must" && !asked.has(c.item) && !briefed.has(c.item)) p.push(`${c.item} is a must-answer item: ask it`);
  }
  for (const q of r.questions) {
    if (q.options.length < 2 || q.options.length > 4) p.push(`question ${q.id} needs 2 to 4 options`);
    if (!(q.recommended >= 0 && q.recommended < q.options.length)) p.push(`question ${q.id}: recommended must index an option`);
    const base = CHECKLIST.find((c) => c.item === q.item);
    if (base?.gate === "must" && q.gate !== "must") p.push(`question ${q.id}: ${q.item} can't be demoted from must`);
  }
  return p;
}

export const generateQuestions = actionGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await requireRoleInAction(ctx as never, key, "editor");
    await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: "questions", error: null } });
    try {
      const p = await getProject(ctx, id);
      const r = await callChecked<QuestionResult>({
        system: SYSTEM, tool: "questions", schema: QUESTION_SCHEMA,
        prompt: `Project "${p.name}". Brief:\n${p.description}\n\nDecision checklist (item, gate, what it covers):\n` +
          CHECKLIST.map((c) => `- ${c.item} (${c.gate}): ${c.about}`).join("\n") +
          `\n\nFor every checklist item decide: the brief already answers it clearly (answered_by_brief), it needs a
question, or it can be a stated assumption. Never ask what the brief already says. Ask every unanswered must item,
then the highest-impact confirm items and project-specific questions, 3 to 8 questions in total. You may promote an
item to "must" when the brief makes it risky, never demote. Each question: plain language, one thing, 2 to 4
mutually exclusive options, each saying in one line what choosing it changes; mark the recommended option and say why
in one line. Nothing about frameworks or code. Ids q1, q2...`,
      }, checkQuestions);
      const answers: Record<string, Answer> = {};
      for (const q of r.questions) if (q.gate === "confirm") answers[q.id] = { option: q.recommended };
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: {
        busy: null, questions: r.questions, answers,
        assumptions: [...r.answered_by_brief.map((a) => ({ item: a.item, text: `From your description: ${a.answer}` })),
                      ...r.assumptions],
      } });
    } catch (e) {
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, error: (e as Error).message } });
    }
  },
});

// ----------------------------------------------------------- step 3: requirements
const STORY = { type: "object", required: ["id", "text", "criteria", "priority"], properties: {
  id: str, text: str, criteria: strArr, priority: { type: "string", enum: ["must", "should", "could", "out"] } } };
const REQ_SCHEMA: JsonSchema = {
  type: "object", required: ["features", "assumptions", "changed"],
  properties: {
    features: { type: "array", items: { type: "object", required: ["id", "name", "summary", "stories"],
      properties: { id: str, name: str, summary: str, stories: { type: "array", items: STORY } } } },
    assumptions: strArr,
    changed: { ...strArr, description: "ids of stories or features you added or changed (empty on a first draft)" },
  },
};
type ReqResult = { features: Feature[]; assumptions: string[]; changed: string[] };

const VAGUE = /\b(fast|easy|simple|intuitive|user[- ]friendly|quickly|nice)\b/i;
export function checkRequirements(r: { features: Feature[] }): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  let musts = 0;
  for (const f of r.features) {
    for (const s of f.stories) {
      if (ids.has(s.id)) p.push(`story id ${s.id} is used twice`);
      ids.add(s.id);
      if (s.priority === "must") musts++;
      if (s.priority !== "out" && (s.criteria.length < 2 || s.criteria.length > 5))
        p.push(`story ${s.id} needs 2 to 5 acceptance criteria`);
      for (const c of s.criteria) if (VAGUE.test(c)) p.push(`story ${s.id}: "${c}" is not checkable by a test`);
    }
  }
  if (!musts) p.push("at least one story must be a Must");
  return p;
}

function answersText(w: Wizard) {
  return (w.questions ?? []).map((q) => {
    const a = w.answers?.[q.id];
    const ans = a?.other ? a.other : a?.option !== undefined ? q.options[a.option]?.label : "(unanswered)";
    return `- ${q.question} -> ${ans}`;
  }).join("\n");
}

const REQ_RULES = `Group user stories by feature. One behavior per story, written like "A customer can ...". Each
story has 2 to 5 acceptance criteria a test can check (concrete values, never "fast" or "easy"). Priorities: must
(first release), should, could, out. Nothing outside the brief and answers is a Must, and every must-answer decision
maps to at least one story. Ids: features F1.., stories S1..`;

export const generateRequirements = actionGeneric({
  args: { key: v.string(), id: v.id("projects"), comment: v.optional(v.string()) },
  handler: async (ctx, { key, id, comment }) => {
    await requireRoleInAction(ctx as never, key, "editor");
    await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: "requirements", error: null } });
    try {
      const p = await getProject(ctx, id);
      const w = p.wizard;
      const base = `Project "${p.name}". Brief:\n${p.description}\n\nAnswers:\n${answersText(w)}\n\nAssumptions:\n` +
        (w.assumptions ?? []).map((a) => `- ${a.text}`).join("\n");
      const prompt = comment && w.requirements
        ? `${base}\n\nCurrent requirements (JSON):\n${JSON.stringify(w.requirements)}\n\nThe user commented: "${comment}"\n` +
          `Revise the requirements to address it, keeping everything else as it is (same ids where unchanged). ` +
          `List added or changed story/feature ids in "changed". ${REQ_RULES}`
        : `${base}\n\nWrite the requirements. ${REQ_RULES} Put the assumptions the user should see in "assumptions".`;
      const r = await callChecked<ReqResult>({ system: SYSTEM, tool: "requirements", schema: REQ_SCHEMA, prompt,
                                               maxTokens: 12000 }, checkRequirements);
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: {
        busy: null, requirements: { features: r.features, assumptions: r.assumptions }, changed: r.changed ?? [] } });
    } catch (e) {
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, error: (e as Error).message } });
    }
  },
});

/** "customers can leave a review" -> a full story with criteria and a suggested priority. */
export const addStory = actionGeneric({
  args: { key: v.string(), id: v.id("projects"), featureId: v.string(), line: v.string() },
  handler: async (ctx, { key, id, featureId, line }) => {
    await requireRoleInAction(ctx as never, key, "editor");
    await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: "requirements", error: null } });
    try {
      const p = await getProject(ctx, id);
      const feats = p.wizard.requirements?.features ?? [];
      const f = feats.find((x) => x.id === featureId);
      if (!f) throw new Error("No such feature.");
      const used = new Set(feats.flatMap((x) => x.stories.map((s) => s.id)));
      let n = used.size + 1;
      while (used.has(`S${n}`)) n++;
      const s = await callChecked<Story>({
        system: SYSTEM, tool: "story", schema: STORY,
        prompt: `Project "${p.name}": ${p.description.slice(0, 2000)}\nFeature "${f.name}": ${f.summary}\n` +
          `The user added: "${line}". Write it as one story with id S${n}, 2 to 5 checkable acceptance criteria and a ` +
          `suggested priority (must only if the brief requires it).`,
      }, (st) => checkRequirements({ features: [{ ...f, stories: [{ ...st, priority: "must" }] }] }));
      const features = feats.map((x) => (x.id === featureId ? { ...x, stories: [...x.stories, { ...s, id: `S${n}` }] } : x));
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: {
        busy: null, requirements: { ...p.wizard.requirements!, features }, changed: [`S${n}`] } });
    } catch (e) {
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, error: (e as Error).message } });
    }
  },
});

// ---------------------------------------------------------------- step 4: stack
/** The catalog. Only Verified options can be built today; others are listed so developers see the roadmap. */
export const CATALOG: { layer: string; verified: string; others: { name: string; tier: string; note: string }[] }[] = [
  { layer: "Frontend", verified: "Next.js (React, TypeScript)", others: [
    { name: "SvelteKit", tier: "Coming soon", note: "Supported tier, template not added yet" },
    { name: "React Native with Expo", tier: "Coming soon", note: "For native mobile apps" }] },
  { layer: "Backend", verified: "Next.js server functions", others: [
    { name: "Node with Hono", tier: "Coming soon", note: "Separate API service" },
    { name: "Python with FastAPI", tier: "Coming soon", note: "Separate API service" }] },
  { layer: "Database", verified: "Postgres on Supabase", others: [
    { name: "Convex", tier: "Coming soon", note: "Verified in the spec; build template in progress" },
    { name: "Neon", tier: "Coming soon", note: "Plain Postgres" }] },
  { layer: "Login", verified: "Supabase Auth", others: [
    { name: "Clerk", tier: "Coming soon", note: "Adds a user-sync task" }] },
  { layer: "Hosting", verified: "Vercel", others: [{ name: "Netlify", tier: "Coming soon", note: "" }] },
  { layer: "Testing", verified: "Vitest (with a real Postgres in every test)", others: [
    { name: "Playwright end-to-end", tier: "Coming soon", note: "Added at integration" }] },
];

export const recommendStack = actionGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await requireRoleInAction(ctx as never, key, "editor");
    await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: "stack", error: null } });
    try {
      const p = await getProject(ctx, id);
      const reqs = JSON.stringify(p.wizard.requirements?.features.map((f) => ({ name: f.name, summary: f.summary })));
      const r = await callChecked<{ summary: string; reasons: { layer: string; reason: string }[] }>({
        system: SYSTEM, tool: "stack",
        schema: { type: "object", required: ["summary", "reasons"], properties: { summary: str,
          reasons: { type: "array", items: { type: "object", required: ["layer", "reason"],
            properties: { layer: str, reason: str } } } } },
        prompt: `Project "${p.name}". Features: ${reqs}\nThe recommended stack is fixed: ` +
          CATALOG.map((c) => `${c.layer}: ${c.verified}`).join("; ") +
          `. Write a one-sentence summary of why this stack fits this project, and one plain-English sentence per layer ` +
          `(layer names exactly: ${CATALOG.map((c) => c.layer).join(", ")}) saying why it fits.`,
      }, (x) => CATALOG.filter((c) => !x.reasons.some((r) => r.layer === c.layer)).map((c) => `missing a reason for ${c.layer}`));
      const layers = CATALOG.map((c) => ({ layer: c.layer, choice: c.verified, tier: "Verified",
        reason: r.reasons.find((x) => x.layer === c.layer)?.reason ?? "", alternatives: c.others }));
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, stack: { summary: r.summary, layers } } });
    } catch (e) {
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, error: (e as Error).message } });
    }
  },
});

// --------------------------------------------------------------- step 5: design
const DESIGN_SCHEMA: JsonSchema = {
  type: "object", required: ["tables", "pages", "flows", "actions", "looks"],
  properties: {
    tables: { type: "array", items: { type: "object", required: ["name", "purpose", "fields", "security"], properties: {
      name: str, purpose: str, security: { ...strArr, description: "who can see/change rows, as plain sentences" },
      fields: { type: "array", items: { type: "object", required: ["name", "type", "why"],
        properties: { name: str, type: str, why: str } } } } } },
    pages: { type: "array", items: { type: "object", required: ["id", "name", "route", "purpose", "stories", "tables", "actions"],
      properties: { id: str, name: str, route: str, purpose: str, stories: strArr, tables: strArr, actions: strArr } } },
    flows: { type: "array", items: { type: "object", required: ["name", "steps"],
      properties: { name: str, steps: { ...strArr, description: "page ids in order" } } } },
    actions: { type: "array", items: { type: "object", required: ["id", "who", "sentence", "kind", "page"], properties: {
      id: str, who: { type: "string", description: "Anyone, Customers, Staff..." }, sentence: str,
      kind: { type: "string", enum: ["read", "write"] }, page: str } } },
    looks: { type: "array", minItems: 3, maxItems: 3, items: { type: "object",
      required: ["id", "name", "description", "palette", "font", "radius"], properties: {
        id: str, name: str, description: str, font: str, radius: str,
        palette: { type: "array", items: { type: "object", required: ["name", "hex"], properties: { name: str, hex: str } } } } } },
  },
};

/** Spec: every Must story maps to a page and an action; every table a page uses exists; every table has a rule. */
export function designWarnings(d: Design, features: Feature[]): string[] {
  const w: string[] = [];
  const tables = new Set(d.tables.map((t) => t.name));
  const musts = features.flatMap((f) => f.stories).filter((s) => s.priority === "must");
  for (const s of musts) {
    if (!d.pages.some((p) => p.stories.includes(s.id))) w.push(`Must story ${s.id} isn't on any page`);
    const pages = d.pages.filter((p) => p.stories.includes(s.id)).map((p) => p.id);
    if (pages.length && !d.actions.some((a) => pages.includes(a.page))) w.push(`Must story ${s.id} has no action on its pages`);
  }
  for (const p of d.pages) for (const t of p.tables) if (!tables.has(t)) w.push(`page ${p.name} uses a table "${t}" that doesn't exist`);
  for (const t of d.tables) if (!t.security.length) w.push(`table ${t.name} has no security rule`);
  w.push(...handSetRoles(d));
  return w;
}

/**
 * The owner rule for the Design step: nobody using Studio can edit an app's database, so a role someone has to set
 * there by hand is a role nobody can ever have (Tool library, Nov 5: its admin pages were unreachable).
 */
export const OWNER_RULE = `The app's owner is its admin. Never design "set by the project owner in the database" or any
role a person must edit by hand: the owner claims the admin role in the app with a setup code on /owner-setup (template
src/lib/owner.ts). Other staff roles, if any, are granted by the owner in the app.`;

const HAND_PLACE = String.raw`(?:directly in (?:the|a|its|our) database|in (?:the|a|its|our) database|by hand|manually|in the supabase (?:dashboard|editor)|with sql)`;
const HAND_SET: RegExp[] = [
  // "the admin role is set by the project owner directly in the database", "is_admin is flipped by hand"
  // (a role merely "stored in the database" is fine: it's who sets it that matters)
  new RegExp(String.raw`\b(?:roles?|is_admin|admin (?:flag|status|rights|access))\b[^.;\n]{0,60}` +
             String.raw`\b(?:set|assigned|granted|given|changed|edited|updated|flipped|toggled|made|promoted|inserted|configured)\b` +
             String.raw`[^.;\n]{0,60}\b${HAND_PLACE}`, "i"),
  // "the owner sets a user as admin in the database", "promote a manager manually"
  new RegExp(String.raw`\b(?:set|sets|setting|assign\w*|grant\w*|promot\w*|make|makes|made|mark\w*|flag\w*|flip\w*|toggl\w*|insert\w*)\b` +
             String.raw`[^.;\n]{0,60}\b(?:admin|administrator|owner|manager|staff)s?\b[^.;\n]{0,60}\b${HAND_PLACE}`, "i"),
  // "admins are added manually", "managers get created by hand in the database"
  new RegExp(String.raw`\b(?:admin|administrator|owner|manager|staff)s?\b[^.;\n]{0,40}\b(?:is|are|get|gets)\s+(?:set|assigned|granted|created|added|made|promoted|marked|flagged|configured|inserted)\b` +
             String.raw`[^.;\n]{0,60}\b${HAND_PLACE}`, "i"),
];

/** Problems (planner-facing) for every place the design has a role set by hand in the database. */
export function handSetRoles(d: Design): string[] {
  const texts: { where: string; text: string }[] = [];
  for (const t of d.tables) {
    texts.push({ where: `table ${t.name}`, text: t.purpose });
    for (const s of t.security) texts.push({ where: `table ${t.name} security`, text: s });
    for (const f of t.fields) texts.push({ where: `field ${t.name}.${f.name}`, text: f.why });
  }
  for (const p of d.pages) texts.push({ where: `page ${p.id}`, text: p.purpose });
  for (const a of d.actions) texts.push({ where: `action ${a.id}`, text: `${a.who} ${a.sentence}` });
  const out: string[] = [];
  for (const { where, text } of texts) {
    for (const sentence of (text ?? "").split(/(?<=[.;!?])\s+|\n/)) {
      if (HAND_SET.some((re) => re.test(sentence))) {
        out.push(`${where} says a role is set by hand in the database ("${sentence.trim().slice(0, 120)}"). Nobody using ` +
                 `the app can do that: the owner is the admin and claims it on /owner-setup with a setup code ` +
                 `(src/lib/owner.ts); other staff roles are granted by the owner in the app`);
        break;
      }
    }
  }
  return out;
}

/** The Design step's rules for the AI (generateDesign). */
export const DESIGN_RULES = `Tables: snake_case names, every field with a plain-English reason, ids are uuid, users are auth.users;
security rules as sentences ("Customers can see only their own bookings"). Pages: ids P1.., routes like /book, each
lists the story ids it covers, the tables it reads and the action ids it calls. Actions: ids A1.., grouped by who may do
them ("Customers can book an appointment for their own pet"), read or write, on one page. Flows: user journeys as page
ids in order. Looks: three distinct visual directions (e.g. "Clean and calm", "Friendly and playful", "Bold and modern")
each with a 5-color palette (hex), a font and a corner rounding. Every Must story must appear on a page that has an action.
${OWNER_RULE}`;

export const generateDesign = actionGeneric({
  args: { key: v.string(), id: v.id("projects"), comment: v.optional(v.string()) },
  handler: async (ctx, { key, id, comment }) => {
    await requireRoleInAction(ctx as never, key, "editor");
    await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: "design", error: null } });
    try {
      const p = await getProject(ctx, id);
      const w = p.wizard;
      const feats = (w.requirements?.features ?? []).map((f) => ({ ...f, stories: f.stories.filter((s) => s.priority !== "out") }));
      const base = `Project "${p.name}". Brief:\n${p.description}\n\nLocked requirements (JSON):\n${JSON.stringify(feats)}\n\n` +
        `Stack: ${(w.stack?.layers ?? []).map((l) => `${l.layer}: ${l.choice}`).join("; ")}.`;
      const rules = DESIGN_RULES;
      const prompt = comment && w.design
        ? `${base}\n\nCurrent design (JSON):\n${JSON.stringify(w.design)}\n\nThe user commented: "${comment}". Revise the design ` +
          `to address it and keep the rest. ${rules}`
        : `${base}\n\nDesign the app. ${rules}`;
      const d = await callChecked<Design>({ system: SYSTEM, tool: "design", schema: DESIGN_SCHEMA, prompt, maxTokens: 16000 },
                                          (x) => designWarnings(x, feats));
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, design: d, look: w.look ?? d.looks[0]?.id } });
    } catch (e) {
      await ctx.runMutation(anyApi.wizard.patch, { id, patch: { busy: null, error: (e as Error).message } });
    }
  },
});

// ------------------------------------------------------- user edits and gates
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { db: { get: (id: any) => Promise<any>; patch: (id: unknown, v: unknown) => Promise<void>; query: (t: any) => any } };

async function edit(ctx: Ctx, key: string, id: unknown, fn: (w: Wizard) => Wizard | string) {
  await requireRole(ctx, key, "editor");
  const p = await ctx.db.get(id);
  if (!p) throw new ConvexError("No such project.");
  if (p.status !== "draft") throw new ConvexError("This project has already started building.");
  const next = fn(JSON.parse(JSON.stringify(p.wizard ?? { step: "questions" })));
  if (typeof next === "string") throw new ConvexError(next);
  await ctx.db.patch(id, { wizard: next });
}

export const answer = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), qid: v.string(), option: v.optional(v.number()), other: v.optional(v.string()) },
  handler: async (ctx, { key, id, qid, option, other }) =>
    edit(ctx as unknown as Ctx, key, id, (w) => {
      if (w.locked?.questions) return "Questions are locked.";
      w.answers = { ...(w.answers ?? {}), [qid]: other?.trim() ? { other: other.trim() } : { option } };
      return w;
    }),
});

export const lockQuestions = mutationGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await edit(ctx as unknown as Ctx, key, id, (w) => {
      const missing = (w.questions ?? []).filter((q) => q.gate === "must" && !w.answers?.[q.id]);
      if (missing.length) return `Please answer: ${missing.map((q) => q.question).join(" / ")}`;
      return { ...w, step: "requirements", locked: { ...w.locked, questions: true } };
    });
    await ctx.scheduler.runAfter(0, anyApi.wizard.generateRequirements, { key, id });
  },
});

export const editStory = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), storyId: v.string(), priority: v.optional(v.string()),
          text: v.optional(v.string()), criteria: v.optional(v.array(v.string())), remove: v.optional(v.boolean()) },
  handler: async (ctx, { key, id, storyId, priority, text, criteria, remove }) =>
    edit(ctx as unknown as Ctx, key, id, (w) => {
      if (w.locked?.requirements) return "Requirements are locked.";
      const feats = w.requirements?.features ?? [];
      for (const f of feats) {
        f.stories = f.stories.flatMap((s) => {
          if (s.id !== storyId) return [s];
          if (remove) return [];
          return [{ ...s, ...(priority ? { priority: priority as Priority } : {}), ...(text ? { text } : {}),
                    ...(criteria ? { criteria: criteria.filter((c) => c.trim()) } : {}) }];
        });
      }
      return w;
    }),
});

export const editFeature = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), featureId: v.optional(v.string()), name: v.optional(v.string()),
          remove: v.optional(v.boolean()) },
  handler: async (ctx, { key, id, featureId, name, remove }) =>
    edit(ctx as unknown as Ctx, key, id, (w) => {
      if (w.locked?.requirements) return "Requirements are locked.";
      const r = w.requirements ?? { features: [], assumptions: [] };
      if (!featureId) {                       // add an empty feature
        const n = r.features.length + 1;
        r.features.push({ id: `F${n}x`, name: name?.trim() || "New feature", summary: "", stories: [] });
      } else if (remove) r.features = r.features.filter((f) => f.id !== featureId);
      else r.features = r.features.map((f) => (f.id === featureId && name ? { ...f, name: name.trim() } : f));
      w.requirements = r;
      return w;
    }),
});

export const lockRequirements = mutationGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await edit(ctx as unknown as Ctx, key, id, (w) => {
      const problems = checkRequirements({ features: w.requirements?.features ?? [] });
      if (problems.length) return `Before locking: ${problems.slice(0, 3).join("; ")}`;
      return { ...w, step: "stack", changed: [], locked: { ...w.locked, requirements: true } };
    });
    await ctx.scheduler.runAfter(0, anyApi.wizard.recommendStack, { key, id });
  },
});

export const lockStack = mutationGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await edit(ctx as unknown as Ctx, key, id, (w) =>
      w.stack ? { ...w, step: "design", locked: { ...w.locked, stack: true } } : "The stack isn't ready yet.");
    await ctx.scheduler.runAfter(0, anyApi.wizard.generateDesign, { key, id });
  },
});

export const chooseLook = mutationGeneric({
  args: { key: v.string(), id: v.id("projects"), look: v.string() },
  handler: async (ctx, { key, id, look }) =>
    edit(ctx as unknown as Ctx, key, id, (w) => (w.locked?.design ? "Design is locked." : { ...w, look })),
});

/** Lock design and start the team: the engine plans tasks from everything locked (Team plan step). */
export const lockDesign = mutationGeneric({
  args: { key: v.string(), id: v.id("projects") },
  handler: async (ctx, { key, id }) => {
    await edit(ctx as unknown as Ctx, key, id, (w) => {
      if (!w.design) return "The design isn't ready yet.";
      const warn = designWarnings(w.design, w.requirements?.features ?? []);
      if (warn.length) return `Fix these first (or comment and let the AI fix them): ${warn.slice(0, 3).join("; ")}`;
      return { ...w, step: "team", locked: { ...w.locked, design: true } };
    });
    await ctx.db.patch(id, { status: "queued" });
    await ctx.scheduler.runAfter(0, anyApi.projects.startWorker, { projectId: id });
  },
});

// ------------------------------------------------------------ internal
export const load = internalQueryGeneric({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    const p = await ctx.db.get(id);
    if (!p) throw new Error("No such project.");
    return { name: p.name, description: p.description, wizard: (p.wizard ?? { step: "questions" }) as Wizard };
  },
});

export const patch = internalMutationGeneric({
  args: { id: v.id("projects"), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const p = await ctx.db.get(id);
    if (!p) return;
    await ctx.db.patch(id, { wizard: { ...(p.wizard ?? { step: "questions" }), ...patch } });
  },
});

/** Everything locked in the wizard, as the brief the engine's planner builds from. */
export function composeSpec(name: string, description: string, w: Wizard | undefined): string {
  if (!w?.locked?.design || !w.design) return description;
  const out: string[] = [`# ${name}`, "", description.trim(), "", "## Decisions", answersText(w), "",
    "## Assumptions", ...(w.assumptions ?? []).map((a) => `- ${a.text}`), ...(w.requirements?.assumptions ?? []).map((a) => `- ${a}`), "",
    "## Requirements (build Must, Should and Could; skip Out)"];
  for (const f of w.requirements?.features ?? []) {
    out.push(`### ${f.name}`, f.summary);
    for (const s of f.stories.filter((x) => x.priority !== "out")) {
      out.push(`- [${s.priority.toUpperCase()}] ${s.id}: ${s.text}`, ...s.criteria.map((c) => `  - Test: ${c}`));
    }
  }
  const d = w.design;
  out.push("", "## Data model (write these as the migrations)");
  for (const t of d.tables) {
    out.push(`- ${t.name}: ${t.purpose}`, ...t.fields.map((f) => `  - ${f.name} (${f.type}): ${f.why}`),
             ...t.security.map((r) => `  - Security: ${r}`));
  }
  out.push("", "## Actions (server functions)", ...d.actions.map((a) => `- ${a.id} [${a.kind}] ${a.who}: ${a.sentence} (page ${a.page})`));
  out.push("", "## Pages", ...d.pages.map((p) => `- ${p.id} ${p.route} ${p.name}: ${p.purpose} (stories ${p.stories.join(", ")}; actions ${p.actions.join(", ")})`));
  const look = d.looks.find((l) => l.id === w.look) ?? d.looks[0];
  if (look) out.push("", `## Look and feel: ${look.name}`, look.description,
                     `Palette: ${look.palette.map((c) => `${c.name} ${c.hex}`).join(", ")}; font ${look.font}; corners ${look.radius}.`);
  out.push("", "Plan tasks for every Must, Should and Could story. Give each task the story ids it serves and its priority " +
               "(the highest priority among those stories).",
           "Every story's Test lines become acceptance tests. Musts come first: Shoulds and Coulds may be saved for a later version.");
  return out.join("\n");
}
