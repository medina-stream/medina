export async function serveSdkBundle() {
  const { outputs, success, logs } = await Bun.build({
    entrypoints: ["./server/sdk.ts"],
    format: "esm",
    target: "browser",
  });

  return success
    ? new Response(outputs[0], {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      })
    : new Response(logs.map((log) => log.message).join("\n"), { status: 500 });
}
