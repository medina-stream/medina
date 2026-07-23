#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const forbidden = [
  /medina\.stream/i,
  /warthog-yo\.ts\.net/i,
  /medina\.exe\.xyz/i,
  /\brailway\b/i,
  /\bwrangler\b/i,
  /\bcloudflare\b/i,
  /\bvercel\b/i,
  /MEDINA_SCO_/,
];
const ignoredDirs = new Set([".git", "node_modules", "dist", "tmp", "out", "static", ".cache", ".wrangler", "expo/node_modules"]);
const ignoredFiles = new Set([
  "AGENTS.md",
  "TODO.md",
  "bun.lock",
  "package-lock.json",
  "expo/package-lock.json",
  "scripts/audit-public-boundary.ts",
]);
const allowed = [
  /^lib\/.*tailscale/i,
  /^server\/.*tailscale/i,
  /^docs\/auth-tailscale\.md$/,
  /^docs\/examples\/streams\.tailscale\.ts$/,
];
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".example", ""]);

function ext(path: string) {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function shouldSkip(rel: string, isDir: boolean) {
  if (isDir) return rel.split("/").some((part, index, parts) => ignoredDirs.has(parts.slice(0, index + 1).join("/")) || ignoredDirs.has(part));
  if (rel.startsWith("test-root/")) return true;
  if (ignoredFiles.has(rel)) return true;
  if (allowed.some((pattern) => pattern.test(rel))) return true;
  return !textExtensions.has(ext(rel));
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const rel = relative(root, path).split("\\").join("/");
    if (!existsSync(path)) continue;
    const stats = statSync(path);
    if (shouldSkip(rel, stats.isDirectory())) continue;
    if (stats.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const findings: string[] = [];
for (const file of walk(root)) {
  const rel = relative(root, file).split("\\").join("/");
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    if (forbidden.some((pattern) => pattern.test(line))) findings.push(`${rel}:${index + 1}: ${line.trim()}`);
  });
}

if (findings.length) {
  console.error("Managed/deployment-specific terms found in core repo:");
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log("Public boundary audit passed.");
