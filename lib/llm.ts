type Message = { role: "system" | "user"; content: string };

type Completion = { choices?: { finish_reason?: string; message?: { content?: string | null } }[] };

function endpoint(env: Env) {
  if (!env.JOURNAL_LLM_API_URL) throw new Error("JOURNAL_LLM_API_URL is not configured");
  return `${env.JOURNAL_LLM_API_URL.replace(/\/$/, "")}/chat/completions`;
}

/**
 * Asks the gateway for one final answer. Reasoning-style models must return
 * their conclusion in `content`; a response without it is a failed run, never a
 * report, so working notes can't reach the page.
 */
export async function completeJournal(env: Env, messages: Message[], maxTokens: number) {
  if (!env.JOURNAL_LLM_MODEL) throw new Error("JOURNAL_LLM_MODEL is not configured");
  const response = await fetch(endpoint(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.JOURNAL_LLM_API_KEY ? { authorization: `Bearer ${env.JOURNAL_LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: env.JOURNAL_LLM_MODEL, messages, max_completion_tokens: maxTokens, reasoning_effort: "low" }),
  });
  if (!response.ok) throw new Error(`Journal LLM request failed: ${response.status} ${await response.text()}`);
  const choice = (await response.json<Completion>()).choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) throw new Error(`Journal LLM response had no final content (finish_reason: ${choice?.finish_reason ?? "none"}); raise the token budget or lower reasoning effort`);
  return content;
}
