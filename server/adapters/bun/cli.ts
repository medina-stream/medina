export async function serveCliBundle() {
  const { outputs, success, logs } = await Bun.build({
    entrypoints: ["./bin/medina-cli.ts"],
    format: "esm",
    target: "bun",
  });

  return success
    ? new Response(outputs[0], {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    : new Response(logs.map((log) => log.message).join("\n"), { status: 500 });
}
