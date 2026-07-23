import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptsDir, "..");
const staticAppDir = resolve(rootDir, process.env.MEDINA_APP_STATIC_DIR ?? "static/app");

function run(command: string[], cwd = rootDir) {
  const proc = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });

  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}

const shouldBuildApp =
  process.env.REBUILD_APP_STATIC === "1"
  || process.env.REBUILD_APP_STATIC === "true"
  || !existsSync(resolve(staticAppDir, "index.html"));

if (shouldBuildApp) {
  run(["bun", "scripts/build-app.ts"]);
}

const server = Bun.spawn(["bun", "--hot", "server/index.ts"], {
  cwd: rootDir,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.kill("SIGTERM");
  });
}

process.exit(await server.exited);
