import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptsDir, "..");
const appDir = resolve(rootDir, "expo");
const appStaticDir = resolve(rootDir, "static/app");

const proc = Bun.spawnSync(["bun", "run", "export:web"], {
  cwd: appDir,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode);
}

const indexPath = resolve(appStaticDir, "index.html");
if (!existsSync(indexPath)) {
  console.error(`Expo export did not produce ${appStaticDir}/index.html`);
  process.exit(1);
}

copyFileSync(resolve(rootDir, "static/app-tabs.css"), resolve(appStaticDir, "app-tabs.css"));
const indexHtml = readFileSync(indexPath, "utf8");
const tabsStylesheet = '<link rel="stylesheet" href="/app/app-tabs.css">';
if (!indexHtml.includes(tabsStylesheet)) {
  writeFileSync(indexPath, indexHtml.replace("</head>", `${tabsStylesheet}</head>`));
}

console.log(`Exported Expo web app to ${appStaticDir}`);
