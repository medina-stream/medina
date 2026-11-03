// Re-attach the media stages' out-of-band Secrets Store bindings
// after an Alchemy deploy.
//
// Why this exists: ASSEMBLYAI_API_KEY and TRANSLOADIT_API_KEY live
// in the account's Secrets Store — Scott placed their values there
// himself (Nov 2) and confirmed them Nov 3 with "flip it live".
// The values are write-only: nobody can read them back, and an
// Alchemy Secrets Store Secret resource would reconcile the stored
// value FROM the deploy environment, destroying Scott's entries.
// Alchemy (beta.83) offers no binding-only declaration against a
// pre-existing store secret (ReadSecret still requires a Secret
// resource), so the two bindings are attached out-of-band, by
// name, the hskping pattern (scripts/reattach-secrets.ts there).
// Alchemy reconciles the Worker's settings against the stack on
// every deploy and STRIPS undeclared bindings, so this runs as the
// second half of `bun run deploy:dev` and re-asserts them.
//
// What it does: read the Worker settings, PATCH them back with the
// two `secrets_store_secret` bindings (re)attached — every other
// binding and the compatibility settings preserved — then read the
// settings back and assert both store secrets are present against
// the right store and the declared INDEX_API_TOKEN binding
// survived. Any failure exits non-zero.
//
// Credentials come from the environment, the established way:
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, as provided by
// ~/workspace/bin/cf_env_run.py:
//
//   cf_env_run.py ~/workspace/medina/cloudflare bun run reattach:secrets
//
// The token is never printed.

const API = "https://api.cloudflare.com/client/v4";
const SCRIPT_NAME = "medina-api-dev-jqvywelf7ukj6sms";
const STORE_ID = "8c3b7231cb714944a163e017ceecfac4";
const SECRET_NAMES = ["ASSEMBLYAI_API_KEY", "TRANSLOADIT_API_KEY"];

interface Binding {
  type?: string;
  name?: string;
  store_id?: string;
  secret_name?: string;
  [key: string]: unknown;
}

interface WorkerSettings {
  bindings?: Binding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  exports?: unknown;
  [key: string]: unknown;
}

const fail = (message: string): never => {
  console.error(`reattach-secrets: ${message}`);
  process.exit(1);
};

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token) fail("CLOUDFLARE_API_TOKEN is not set (run via cf_env_run.py)");
if (!accountId) {
  fail("CLOUDFLARE_ACCOUNT_ID is not set (run via cf_env_run.py)");
}

const settingsUrl = `${API}/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/settings`;
const headers = { Authorization: `Bearer ${token}` };

const call = async (
  method: string,
  body?: BodyInit,
): Promise<{ status: number; payload: any }> => {
  const res = await fetch(settingsUrl, { method, headers, body });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    // leave null; the status check below reports it
  }
  return { status: res.status, payload };
};

const describeErrors = (payload: any): string =>
  Array.isArray(payload?.errors) && payload.errors.length > 0
    ? payload.errors
        .map((e: any) => `${e?.code ?? "?"}: ${e?.message ?? "unknown error"}`)
        .join("; ")
    : "no error detail";

const getSettings = async (step: string): Promise<WorkerSettings> => {
  const { status, payload } = await call("GET");
  if (status !== 200 || payload?.success !== true || !payload?.result) {
    fail(
      `${step}: GET settings failed (HTTP ${status}): ${describeErrors(payload)}`,
    );
  }
  return payload.result as WorkerSettings;
};

// 1. Read the current settings; every binding found is preserved.
const before = await getSettings("read current settings");
const bindings: Binding[] = [...(before.bindings ?? [])];
const present = new Set(bindings.map((b) => b.name));
const added: string[] = [];
for (const name of SECRET_NAMES) {
  if (!present.has(name)) {
    bindings.push({
      type: "secrets_store_secret",
      name,
      store_id: STORE_ID,
      secret_name: name,
    });
    added.push(name);
  }
}
console.log(
  added.length > 0
    ? `reattaching: ${added.join(", ")}`
    : "both store secrets already bound; re-asserting settings as-is",
);

// 2. PATCH the settings back. The multipart body carries only the
// `settings` part; the compatibility settings are carried over
// from the current ones. The Durable Object exports declaration
// must ride along even though GET settings reports it as null:
// the settings API reconciles provisioned DO namespaces against
// `exports` and rejects the PATCH when a provisioned class is not
// declared (the hskping lesson, confirmed on this Worker — every
// class here is sqlite-backed, as Alchemy provisioned them).
const exportsPatch: Record<string, unknown> = {
  ...((before.exports as Record<string, unknown> | null) ?? {}),
};
for (const binding of before.bindings ?? []) {
  if (binding.type === "durable_object_namespace" && binding.name) {
    exportsPatch[binding.name] = {
      type: "durable-object",
      storage: "sqlite",
    };
  }
}
const patch: Record<string, unknown> = {
  bindings,
  compatibility_date: before.compatibility_date,
  compatibility_flags: before.compatibility_flags ?? [],
  exports: exportsPatch,
};
const form = new FormData();
form.append(
  "settings",
  new Blob([JSON.stringify(patch)], { type: "application/json" }),
);
const { status: patchStatus, payload: patchPayload } = await call(
  "PATCH",
  form,
);
if (patchStatus !== 200 || patchPayload?.success !== true) {
  fail(
    `PATCH settings failed (HTTP ${patchStatus}): ${describeErrors(patchPayload)}`,
  );
}
console.log(`PATCH settings: HTTP ${patchStatus}, success`);

// 3. Read back and assert: the binding count grew by exactly the
// number attached, both store secrets are present as
// secrets_store_secret bindings against the right store, and the
// stack-declared INDEX_API_TOKEN binding is still there.
const after = await getSettings("read back settings");
const afterBindings = after.bindings ?? [];
const problems: string[] = [];
const expectedCount = (before.bindings ?? []).length + added.length;
if (afterBindings.length !== expectedCount) {
  problems.push(
    `expected ${expectedCount} bindings, found ${afterBindings.length}`,
  );
}
for (const name of [...SECRET_NAMES, "INDEX_API_TOKEN"]) {
  const binding = afterBindings.find((b) => b.name === name);
  if (!binding) {
    problems.push(`${name}: missing`);
  } else if (
    binding.type !== "secrets_store_secret" ||
    binding.store_id !== STORE_ID ||
    binding.secret_name !== name
  ) {
    problems.push(
      `${name}: wrong binding (type=${binding.type}, store_id=${binding.store_id}, secret_name=${binding.secret_name})`,
    );
  }
}
console.log(`read-back bindings: ${afterBindings.length}`);
for (const b of afterBindings) {
  console.log(`  ${b.type} ${b.name}`);
}
if (problems.length > 0) {
  fail(`read-back assertion failed — ${problems.join("; ")}`);
}
console.log(
  `reattach-secrets: OK — ${afterBindings.length} bindings, both media-stage store secrets present`,
);
