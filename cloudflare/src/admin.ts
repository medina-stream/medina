/**
 * Capture-policy token administration on the Worker (step 11's
 * write surface): the `/devices` page and the token admin API,
 * ported from the bun server (lib/lifelog/Pages.tsx `devicesPage`,
 * lib/lifelog/devices-client.ts, and the registry operations behind
 * lib/capture/CapturePolicy.ts).
 *
 * The registry itself is the same bucket object the capture policy
 * and every token gate already read — `capture-policy/tokens.json`
 * in the artifacts bucket: `{version: 1, tokens: [{id, label, hash,
 * createdAt, revokedAt, lastUsedAt}]}`, hashes only (SHA-256 hex of
 * the token). Issuing mints `cpol_` + base64url(32 random bytes),
 * like the server; the plaintext is shown exactly once, in the
 * issue response.
 *
 * Gating: the server fenced this surface with the tailnet (its
 * fullAccess check). Here it is session-only — the human lane of
 * the step-12 gate swap. A machine token can fetch a policy
 * document; it cannot list, mint, or revoke credentials.
 *
 * One overlap to know about: while the old server still runs, its
 * mirror writes (its own issue/revoke, and its flush of last-used
 * times) rewrite the same registry object from its in-memory copy,
 * so a token minted here could be lost if the server writes after
 * having loaded a stale copy. The window closes when the server
 * retires (§4.3 retirement); until then, mint tokens here OR there,
 * not both in the same hour.
 */
import * as Effect from "effect/Effect";

export interface AdminBucket {
  get(key: string): Promise<{
    readonly body: ReadableStream;
    readonly size: number;
    readonly httpEtag: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    value: string | Uint8Array,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

const REGISTRY_KEY = "capture-policy/tokens.json";

export interface TokenRecord {
  readonly id: string;
  readonly label: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

interface RegistryShape {
  readonly version: 1;
  readonly tokens: Array<TokenRecord>;
}

const sha256Hex = (value: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });

const readRegistry = (
  bucket: AdminBucket,
): Effect.Effect<RegistryShape> =>
  Effect.gen(function* () {
    const object = yield* Effect.promise(() => bucket.get(REGISTRY_KEY));
    if (object === null) return { version: 1, tokens: [] };
    const text = yield* Effect.promise(async () =>
      new Response(object.body).text(),
    );
    try {
      const parsed = JSON.parse(text) as Partial<RegistryShape>;
      return {
        version: 1,
        tokens: Array.isArray(parsed.tokens)
          ? (parsed.tokens as Array<TokenRecord>)
          : [],
      };
    } catch {
      return { version: 1, tokens: [] };
    }
  });

const writeRegistry = (
  bucket: AdminBucket,
  registry: RegistryShape,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await bucket.put(REGISTRY_KEY, JSON.stringify(registry, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  }).pipe(Effect.asVoid);

export const listTokens = (bucket: AdminBucket) =>
  Effect.map(readRegistry(bucket), (registry) =>
    registry.tokens.map((token) => ({
      id: token.id,
      label: token.label,
      createdAt: token.createdAt,
      revokedAt: token.revokedAt,
      lastUsedAt: token.lastUsedAt,
      active: token.revokedAt === null,
    })),
  );

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Mint a token — the server's recipe, verbatim: the value is
 * `cpol_` + base64url(32 random bytes), the id is base64url(18
 * random bytes), the stored hash is the token's SHA-256 hex, the
 * label is trimmed, whitespace-collapsed, capped at 120 chars, and
 * defaults to "unnamed device"; the record is appended. */
export const issueToken = (
  bucket: AdminBucket,
  label: string,
): Effect.Effect<{ readonly id: string; readonly token: string }> =>
  Effect.gen(function* () {
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = `cpol_${base64url(tokenBytes)}`;
    const idBytes = new Uint8Array(18);
    crypto.getRandomValues(idBytes);
    const record: TokenRecord = {
      id: base64url(idBytes),
      label:
        label.trim().replace(/\s+/g, " ").slice(0, 120) ||
        "unnamed device",
      hash: yield* sha256Hex(token),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastUsedAt: null,
    };
    const registry = yield* readRegistry(bucket);
    yield* writeRegistry(bucket, {
      version: 1,
      tokens: [...registry.tokens, record],
    });
    return { id: record.id, token };
  });

export const revokeToken = (
  bucket: AdminBucket,
  id: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const registry = yield* readRegistry(bucket);
    const existing = registry.tokens.find((token) => token.id === id);
    if (existing === undefined) return false;
    yield* writeRegistry(bucket, {
      version: 1,
      tokens: registry.tokens.map((token) =>
        token.id === id
          ? { ...token, revokedAt: new Date().toISOString() }
          : token,
      ),
    });
    return true;
  });

// ---------------------------------------------------------------------------
// The page + its client script (the server's devices page, with the
// script inlined — one less client asset to publish; the calls are
// the server's, same-origin relative paths).
// ---------------------------------------------------------------------------

const DEVICES_SCRIPT = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function call(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function fmt(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }
async function refresh() {
  const status = $("status");
  try {
    const data = await call("/api/capture-policy/tokens");
    const rows = data.tokens.map((t) =>
      "<tr><td>" + esc(t.label) + "</td><td>" + fmt(t.createdAt) + "</td><td>" + fmt(t.lastUsedAt) + "</td>" +
      "<td>" + (t.active ? "active" : "revoked " + fmt(t.revokedAt)) + "</td>" +
      "<td>" + (t.active ? '<button data-revoke="' + esc(t.id) + '">Revoke</button>' : "") + "</td></tr>"
    ).join("");
    $("tokens").innerHTML = rows || '<tr><td colspan="5">No device links yet.</td></tr>';
    document.querySelectorAll("[data-revoke]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("Revoke this link? The phone using it will stop being able to upload.")) return;
        await call("/api/capture-policy/tokens/" + encodeURIComponent(button.dataset.revoke) + "/revoke", { method: "POST" });
        refresh();
      });
    });
    status.textContent = "";
  } catch (error) {
    status.textContent = String(error && error.message || error);
  }
}
$("create").addEventListener("click", async () => {
  const label = $("label").value.trim();
  const out = $("created");
  if (!label) { out.textContent = "Give the device a label first."; return; }
  try {
    const data = await call("/api/capture-policy/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    out.innerHTML = "";
    const code = document.createElement("code");
    code.textContent = data.url;
    out.append(code, document.createTextNode(" — copy it now: the full link is shown only once. On the phone, open it once and tap Allow always when Android asks about the battery prompt."));
    $("label").value = "";
    refresh();
  } catch (error) {
    out.textContent = String(error && error.message || error);
  }
});
refresh();
`;

export const devicesPage = (hostname: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capture devices — ${hostname}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  td, th { border-bottom: 1px solid #ddd; padding: .4rem .5rem; text-align: left; font-size: .9rem; }
  code { word-break: break-all; background: #f3f3f3; padding: .2rem .4rem; border-radius: .3rem; }
  input { padding: .4rem; width: 16rem; }
  button { padding: .4rem .8rem; }
  #created { margin-top: 1rem; }
  #status { color: #a00; }
</style></head><body>
<h1>Capture devices</h1>
<p>Each phone gets its own configuration link. The link carries a
per-device token: opening it serves the capture policy, and the app
polls it about once a day. Revoking a link stops that phone's
uploads without touching the others.</p>
<p><input id="label" placeholder="Device label, e.g. Pixel 10a"> <button id="create">Create link</button></p>
<div id="created"></div>
<p id="status"></p>
<table><thead><tr><th>Label</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
<tbody id="tokens"></tbody></table>
<script>${DEVICES_SCRIPT}</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Routing. Session-gated by the caller-supplied check; returns null
// for paths outside this surface.
// ---------------------------------------------------------------------------

export interface AdminGates {
  readonly authorizeSession: (
    request: Request,
  ) => Effect.Effect<boolean>;
  readonly signInPath: string;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const notFound = (): Response => jsonResponse({ error: "not found" }, 404);

export const handleAdmin = (
  request: Request,
  bucket: AdminBucket,
  url: URL,
  gates: AdminGates,
): Effect.Effect<Response | null> =>
  Effect.gen(function* () {
    const path = url.pathname;
    const isPage = request.method === "GET" && path === "/devices";
    const isList =
      request.method === "GET" && path === "/api/capture-policy/tokens";
    const isIssue =
      request.method === "POST" && path === "/api/capture-policy/tokens";
    const revokeMatch =
      request.method === "POST"
        ? path.match(/^\/api\/capture-policy\/tokens\/([^/]+)\/revoke$/)
        : null;
    if (!isPage && !isList && !isIssue && revokeMatch === null) {
      return null;
    }
    const sessionOk = yield* gates.authorizeSession(request);
    if (!sessionOk) {
      if (isPage) {
        const target = new URL(gates.signInPath, url);
        target.searchParams.set("next", url.pathname);
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }
      return notFound();
    }
    if (isPage) {
      return new Response(devicesPage(url.hostname), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (isList) {
      const tokens = yield* listTokens(bucket);
      return jsonResponse({ tokens });
    }
    if (isIssue) {
      const body = yield* Effect.promise(async () => {
        try {
          return (await request.json()) as { label?: unknown };
        } catch {
          return null;
        }
      });
      if (body === null || typeof body.label !== "string") {
        return jsonResponse({ error: "label required" }, 400);
      }
      const label = body.label;
      const issued = yield* issueToken(bucket, label);
      return jsonResponse({
        id: issued.id,
        token: issued.token,
        url: `${url.origin}/api/capture-policy/${issued.token}`,
      });
    }
    const revoked = yield* revokeToken(
      bucket,
      decodeURIComponent(revokeMatch![1]!),
    );
    return revoked
      ? jsonResponse({ ok: true })
      : jsonResponse({ error: "unknown token id" }, 404);
  });
