/**
 * One structured Claude call: the model must answer by "calling" a tool whose input schema is the JSON we
 * want, so the result is always parseable JSON in a known shape. Code checks the content afterwards.
 * Uses ANTHROPIC_API_KEY from this deployment's environment (never sent to the browser).
 */
export type JsonSchema = Record<string, unknown>;

export async function callClaude<T>(opts: {
  system: string;
  prompt: string;
  tool: string;
  schema: JsonSchema;
  maxTokens?: number;
}): Promise<T> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Convex (Settings > Environment Variables).");
  const model = process.env.WIZARD_MODEL ?? "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 8000,
      system: opts.system,
      tools: [{ name: opts.tool, description: "Return the result.", input_schema: opts.schema }],
      tool_choice: { type: "tool", name: opts.tool },
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Claude call failed (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
  const body = (await r.json()) as { content: { type: string; input?: unknown }[]; usage?: { input_tokens: number; output_tokens: number } };
  const block = body.content.find((c) => c.type === "tool_use");
  if (!block?.input) throw new Error("Claude returned no structured result.");
  return block.input as T;
}

/** Ask, check with code, and if the checks fail ask once more with the problems listed. */
export async function callChecked<T>(
  opts: Parameters<typeof callClaude>[0],
  check: (value: T) => string[],
): Promise<T> {
  let value = await callClaude<T>(opts);
  let problems = check(value);
  if (problems.length) {
    value = await callClaude<T>({
      ...opts,
      prompt: `${opts.prompt}\n\nYour previous answer had these problems; fix them all:\n- ${problems.join("\n- ")}`,
    });
    problems = check(value);
    if (problems.length) throw new Error(`The result still had problems: ${problems.slice(0, 3).join("; ")}`);
  }
  return value;
}
