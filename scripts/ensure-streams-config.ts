import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const streamsPath = resolve(rootDir, "medina.config.ts");
const templatePath = resolve(rootDir, process.env.MEDINA_STREAMS_TEMPLATE || "docs/streams-basic.ts");
const streamsExists = existsSync(streamsPath);
const templateExists = existsSync(templatePath);
const shouldOverwrite = Boolean(process.env.MEDINA_STREAMS_TEMPLATE);

if (!streamsExists || shouldOverwrite) {
  if (!templateExists) {
    console.error(`[ensure-streams-config] stream template not found: ${templatePath}`);
    process.exit(1);
  }
  copyFileSync(templatePath, streamsPath);
  console.log(`[ensure-streams-config] copied ${templatePath} to medina.config.ts`);
} else {
  console.log("[ensure-streams-config] medina.config.ts already exists");
}
