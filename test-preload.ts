/**
 * Test hermeticity: no test may touch the real data dir.
 *
 * `bun test` auto-loads `.env`, and a deployment's `.env` points DATA_DIR at
 * the real lifelog (possibly a network mount). `lifelog/Resources.ts` captures
 * DATA_DIR at import time, so this must run before any test file imports
 * anything. Every test process gets a fresh temp data dir; tests that need
 * captures create their own.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "medina-test-data-"))
