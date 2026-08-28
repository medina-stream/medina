type Message = { role: "system" | "user"; content: string };

type Completion = { choices?: { message?: { content?: string | null } }[] };

function endpoint(env: Env) {
  if (!env.JOURNAL_LLM_API_URL) throw new Error("JOURNAL_LLM_API_URL is not configured");
  return `${env.JOURNAL_LLM_API_URL.replace(/\/$/, "")}/chat/completions`;
}

export async function completeJournal(env: Env, messages: Message[], maxTokens: number) {
  if (!env.JOURNAL_LLM_MODEL) throw new Error("JOURNAL_LLM_MODEL is not configured");
  const response = await fetch(endpoint(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.JOURNAL_LLM_API_KEY ? { authorization: `Bearer ${env.JOURNAL_LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: env.JOURNAL_LLM_MODEL, messages, max_tokens: maxTokens }),
  });
  if (!response.ok) throw new Error(`Journal LLM request failed: ${response.status} ${await response.text()}`);
  const completion = await response.json<Completion>();
  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error("Journal LLM response was missing message content");
  return content;
}
