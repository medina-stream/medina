import { mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { Database } from "bun:sqlite";
import { applyMigrations } from "migralite";

function expandHome(p: string) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const dataDirRaw = process.env.DATA_DIR ?? "~/.medina";
export const dataDir = resolve(expandHome(dataDirRaw));
const moduleDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(moduleDir, "./migrations");

mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "medina.db");
export const db = new Database(dbPath, { create: true });

export async function migrate() {
    try {
        await applyMigrations(db, migrationsDir);
    } catch (err) {
        console.error(err);
    }
}
