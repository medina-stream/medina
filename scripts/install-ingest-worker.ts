#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const systemdDir = join(homedir(), ".config", "systemd", "user");
mkdirSync(systemdDir, { recursive: true });

const concurrency = Number(process.env.INGEST_WORKER_CONCURRENCY ?? "2");

const service = `[Unit]
Description=Materialize Medina ingests (analysis → recordings → chunks → intervals)
After=default.target

[Service]
Type=simple
WorkingDirectory=${root}
EnvironmentFile=${root}/.env
Environment=PATH=${homedir()}/.bun/bin:${homedir()}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${homedir()}/.bun/bin/bun ${root}/scripts/ingest-worker.ts --concurrency ${concurrency}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;

const servicePath = join(systemdDir, "medina-ingest-worker.service");
writeFileSync(servicePath, service);
console.log(servicePath);
