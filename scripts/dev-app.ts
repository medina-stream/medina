import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptsDir, "..");
const appDir = resolve(rootDir, "expo");
const port = process.env.EXPO_DEV_SERVER_PORT ?? "8082";

const proc = Bun.spawn(["bun", "run", "start", "--", "--port", port], {
  cwd: appDir,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

process.exit(await proc.exited);
