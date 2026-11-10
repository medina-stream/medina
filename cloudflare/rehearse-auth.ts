/**
 * Live rehearsal of the step-12 auth surface against the deployed
 * Worker, with a THROWAWAY account (created here, deleted by the
 * operator's bucket wipe afterwards — this script only reports).
 * Exercises: bootstrap POST → sign-in → session cookie → journal
 * HTML with session → SavePlaces RPC → token admin (list / issue /
 * policy fetch with the minted token / revoke) → sign-out.
 * Prints statuses and shapes only, never credential values.
 */
const base = "https://sco.medina.stream";
const email = "rehearsal@example.com";
const password = "rehearsal-throwaway-123";
const displayName = "Rehearsal (throwaway)";

const jar = new Map<string, string>();
const absorb = (res: Response) => {
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const pair = setCookie.split(";")[0]!;
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
};
const cookies = () =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

const step = (name: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

const main = async () => {
  // 1. bootstrap the throwaway account
  const boot = await fetch(`${base}/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, displayName, password }).toString(),
    redirect: "manual",
  });
  step("bootstrap POST", boot.status === 302, `status ${boot.status}`);

  const bootAgain = await fetch(`${base}/auth/bootstrap`);
  step("bootstrap closed after first account", bootAgain.status === 404, `status ${bootAgain.status}`);

  // 2. sign in through the framework operation
  const signIn = await fetch(`${base}/auth/signIn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base,
      "x-effect-auth-csrf": "1",
    },
    body: JSON.stringify({
      payload: { email, password, flowId: crypto.randomUUID() },
    }),
  });
  absorb(signIn);
  const signInBody = await signIn.text();
  step(
    "signIn",
    signIn.status === 200 && jar.has("__Host-effect-auth-session"),
    `status ${signIn.status}, body ${signInBody.slice(0, 120)}`,
  );

  // 3. journal HTML with the session
  const home = await fetch(`${base}/`, {
    headers: { cookie: cookies(), accept: "text/html" },
    redirect: "manual",
  });
  step("GET / with session", home.status === 200, `status ${home.status}`);

  // 4. SavePlaces over the session lane (marker place; the operator
  // restores places.json afterwards)
  const rpc = (tag: string, payload: unknown) =>
    fetch(`${base}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        cookie: cookies(),
      },
      body: JSON.stringify({
        _tag: "Request",
        id: "1",
        tag,
        payload,
        headers: [],
      }) + "\n",
    });
  const listBefore = await rpc("ListPlaces", {});
  const listBeforeText = await listBefore.text();
  const marker = {
    name: "Rehearsal Marker Place",
    lat: 37.7749,
    lon: -122.4194,
    radiusM: 100,
    aliases: [],
  };
  // Decode the current list from the RPC stream's first line.
  let currentPlaces: Array<unknown> = [];
  try {
    const line = listBeforeText.split("\n").find((l) => l.includes("Success"));
    if (line) {
      const parsed = JSON.parse(line) as {
        value?: { result?: Array<unknown> };
      };
      currentPlaces = parsed.value?.result ?? [];
    }
  } catch {}
  const save = await rpc("SavePlaces", {
    places: [...currentPlaces, marker],
  });
  const saveText = await save.text();
  step(
    "SavePlaces (session lane)",
    save.status === 200 && saveText.includes("Success"),
    `status ${save.status}, body ${saveText.slice(0, 160)}`,
  );

  // 5. token admin over the session
  const listRes = await fetch(`${base}/api/capture-policy/tokens`, {
    headers: { cookie: cookies() },
  });
  const listJson = (await listRes.json()) as { tokens: Array<unknown> };
  step("admin list", listRes.status === 200, `${listJson.tokens.length} tokens`);

  const issueRes = await fetch(`${base}/api/capture-policy/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies() },
    body: JSON.stringify({ label: "rehearsal-throwaway" }),
  });
  const issued = (await issueRes.json()) as {
    id: string;
    token: string;
    url: string;
  };
  step("admin issue", issueRes.status === 200 && issued.token.startsWith("cpol_"), `status ${issueRes.status}`);

  const policy = await fetch(`${base}/api/capture-policy/${issued.token}`);
  step("policy fetch with minted token", policy.status === 200, `status ${policy.status}`);

  const revokeRes = await fetch(
    `${base}/api/capture-policy/tokens/${issued.id}/revoke`,
    { method: "POST", headers: { cookie: cookies() } },
  );
  step("admin revoke", revokeRes.status === 200, `status ${revokeRes.status}`);
  const policyAfter = await fetch(`${base}/api/capture-policy/${issued.token}`);
  step("policy fetch after revoke", policyAfter.status === 404, `status ${policyAfter.status}`);

  // 6. token lane still reads journal JSON (no session)
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const jsonNoAuth = await fetch(`${base}/journal/${day}`, { redirect: "manual" });
  step("journal JSON without any credential", jsonNoAuth.status === 404, `status ${jsonNoAuth.status}`);

  // 7. devices page with session
  const devices = await fetch(`${base}/devices`, {
    headers: { cookie: cookies() },
    redirect: "manual",
  });
  step("GET /devices with session", devices.status === 200, `status ${devices.status}`);
};

main().catch((error) => {
  console.error("REHEARSAL FAILED", error);
  process.exit(1);
});
