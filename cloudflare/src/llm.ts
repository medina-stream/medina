/**
 * The Worker's LLM path: OpenAI models through Scott's Cloudflare
 * AI Gateway (migration milestone 4, step 9 —
 * docs/cloudflare-migration.md §4.3 step 9). The server calls its
 * journal LLM through an exe.dev OpenAI relay; the Worker calls
 * the gateway instead, per Scott's Nov 2, 2026 decision: gateway
 * id `default` on his account, target model gpt-5.5, the OpenAI
 * provider key stored in the gateway's own config (BYOK) so no
 * provider key ever transits this Worker.
 *
 * Two endpoint shapes exist and the probe below exercises both:
 *
 *   - the provider endpoint, `…/openai/chat/completions`, where
 *     the model field is the bare model name (`gpt-5.5`);
 *   - the OpenAI-compatible "compat" endpoint,
 *     `…/compat/chat/completions`, where the model field carries
 *     the provider prefix (`openai/gpt-5.5`).
 *
 * The completion client uses the provider endpoint (the shape the
 * gateway documentation leads with for a single-provider route);
 * the probe tries every combination so a deployment whose gateway
 * is wired the other way shows it in the verify report instead of
 * failing journal passes opaquely.
 *
 * If the gateway is authenticated, requests carry
 * `cf-aig-authorization: Bearer <token>`, the token being the
 * Secrets Store secret AI_GATEWAY_TOKEN, attached out-of-band
 * (scripts/reattach-secrets.ts) and read through its binding at
 * call time — the value never appears in code, logs, or reports.
 * Whether the header is required is an empirical question the
 * probe answers: it tries without the header first, then with it.
 *
 * The completion contract mirrors the server's `complete()`
 * (lib/lifelog/Journal.ts): one system + one user message, the
 * model's reasoning effort pinned low (the server layer's config),
 * a per-call output-token cap, and a reasoning-only response with
 * no final text is a FAILURE, never a result — working notes must
 * not reach the page. No retries here: the journal pass's hourly
 * attempt window is the retry mechanism, exactly as the server's
 * workflow attempt windows are.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const GATEWAY_ACCOUNT_ID = "22e64798cbb760891764f349b53f573a";
export const GATEWAY_ID = "default";

const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${GATEWAY_ACCOUNT_ID}/${GATEWAY_ID}`;
export const GATEWAY_PROVIDER_URL = `${GATEWAY_BASE}/openai`;
export const GATEWAY_COMPAT_URL = `${GATEWAY_BASE}/compat`;

export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly message: string;
  readonly status: number | null;
  readonly cause: unknown;
}> {}

export interface GatewayCompleteOptions {
  /** The AI_GATEWAY_TOKEN value, when a binding resolved one;
   * null sends no gateway-auth header (an unauthenticated
   * gateway, or a token that is not placed yet). */
  readonly token: string | null;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

interface ChatCompletionBody {
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly role: "system" | "user";
    readonly content: string;
  }>;
  readonly max_completion_tokens: number;
  readonly reasoning_effort: "low";
}

const completionBody = (
  model: string,
  system: string | null,
  user: string,
  maxTokens: number,
): ChatCompletionBody => ({
  model,
  messages: [
    ...(system !== null
      ? [{ role: "system" as const, content: system }]
      : []),
    { role: "user" as const, content: user },
  ],
  max_completion_tokens: maxTokens,
  reasoning_effort: "low",
});

/** The final text of a chat-completions response, or a description
 * of why there is none. Content may arrive as a plain string or as
 * an array of typed parts; both are flattened. */
const finalText = (
  body: unknown,
): { readonly text: string; readonly finishReason: string | null } => {
  if (typeof body !== "object" || body === null) {
    return { text: "", finishReason: null };
  }
  const choices = (body as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { text: "", finishReason: null };
  }
  const choice = choices[0] as Record<string, unknown>;
  const finishReason =
    typeof choice["finish_reason"] === "string"
      ? choice["finish_reason"]
      : null;
  const message = choice["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (typeof content === "string") return { text: content, finishReason };
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as Record<string, unknown>)["text"] === "string"
          ? ((part as Record<string, unknown>)["text"] as string)
          : "",
      )
      .join("");
    return { text, finishReason };
  }
  return { text: "", finishReason };
};

/** A gateway error body's human-readable message, when it carries
 * one (OpenAI-shaped `error.message`, or the gateway's own). Never
 * includes request material, so it is safe to surface in reports. */
const errorDetail = (body: unknown, status: number): string => {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string" && message.length > 0) {
        return message.slice(0, 200);
      }
    }
    if (typeof error === "string" && error.length > 0) {
      return error.slice(0, 200);
    }
  }
  return `gateway answered ${status}`;
};

const postCompletion = (
  url: string,
  token: string | null,
  body: ChatCompletionBody,
  timeoutMs: number,
): Effect.Effect<
  { readonly status: number; readonly body: unknown },
  GatewayError
> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== null
            ? { "cf-aig-authorization": `Bearer ${token}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const parsed: unknown = await response.json().catch(() => null);
      return { status: response.status, body: parsed };
    },
    catch: (cause) =>
      new GatewayError({
        message: `gateway request failed: ${String(cause).slice(0, 200)}`,
        status: null,
        cause,
      }),
  });

/**
 * One completion through the gateway's provider endpoint — the
 * journal port's `complete()`. Fails on a non-200 answer and on a
 * 200 with no final text, mirroring the server.
 */
export const gatewayComplete = (
  options: GatewayCompleteOptions,
): Effect.Effect<string, GatewayError> =>
  Effect.gen(function* () {
    const { status, body } = yield* postCompletion(
      `${GATEWAY_PROVIDER_URL}/chat/completions`,
      options.token,
      completionBody(options.model, options.system, options.user, options.maxTokens),
      240_000,
    );
    if (status !== 200) {
      return yield* Effect.fail(
        new GatewayError({
          message: errorDetail(body, status),
          status,
          cause: null,
        }),
      );
    }
    const { text, finishReason } = finalText(body);
    const content = text.trim();
    if (!content) {
      return yield* Effect.fail(
        new GatewayError({
          message: `journal LLM returned no final content (finish: ${finishReason ?? "unknown"})`,
          status,
          cause: null,
        }),
      );
    }
    return content;
  });

// ---------------------------------------------------------------------------
// The probe: which endpoint/auth combination does this gateway
// answer? Used by the gated GET /journal/verify route — the step
// 5–6 vendor-verify pattern. Each attempt is one tiny completion;
// reports carry statuses and error text only, never the token.
// ---------------------------------------------------------------------------

export interface GatewayProbeAttempt {
  readonly endpoint: "openai" | "compat";
  readonly auth: "none" | "token";
  readonly status: number | null;
  readonly ok: boolean;
  readonly detail: string;
}

export const probeGateway = (
  token: string | null,
  model: string,
): Effect.Effect<ReadonlyArray<GatewayProbeAttempt>> =>
  Effect.gen(function* () {
    const attempts: Array<GatewayProbeAttempt> = [];
    const combos: Array<{
      endpoint: "openai" | "compat";
      auth: "none" | "token";
    }> = [
      { endpoint: "openai", auth: "none" },
      ...(token !== null
        ? [{ endpoint: "openai", auth: "token" } as const]
        : []),
      { endpoint: "compat", auth: "none" },
      ...(token !== null
        ? [{ endpoint: "compat", auth: "token" } as const]
        : []),
    ];
    for (const combo of combos) {
      const url =
        combo.endpoint === "openai"
          ? `${GATEWAY_PROVIDER_URL}/chat/completions`
          : `${GATEWAY_COMPAT_URL}/chat/completions`;
      const attemptModel =
        combo.endpoint === "openai" ? model : `openai/${model}`;
      const outcome = yield* postCompletion(
        url,
        combo.auth === "token" ? token : null,
        completionBody(
          attemptModel,
          null,
          "Reply with the single word: ok",
          200,
        ),
        60_000,
      ).pipe(
        Effect.map((result) => ({ kind: "answered" as const, ...result })),
        Effect.catch((error) =>
          Effect.succeed({
            kind: "failed" as const,
            message: error.message,
          }),
        ),
      );
      if (outcome.kind === "failed") {
        attempts.push({
          ...combo,
          status: null,
          ok: false,
          detail: outcome.message.slice(0, 200),
        });
        continue;
      }
      const { text } = finalText(outcome.body);
      attempts.push({
        ...combo,
        status: outcome.status,
        ok: outcome.status === 200 && text.trim().length > 0,
        detail:
          outcome.status === 200
            ? `final text ${text.trim().length} chars`
            : errorDetail(outcome.body, outcome.status),
      });
    }
    return attempts;
  });
