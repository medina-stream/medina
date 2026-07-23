export function createAgentsDocs(baseUrl: string) {
  const endpoint = process.env.MEDINA_ROOT?.trim() || baseUrl;
  return `# Medina agents guide

This Medina server powers Scott Raymond's lifestream/context lake.

## Recommended integration strategies

### 1. Use the CLI — best default for agents

If you can run Bun, start here. The CLI wraps the HTTP API, handles auth defaults, and produces shell-friendly output.

\`\`\`sh
export MEDINA_ROOT="${endpoint}"
export MEDINA_TOKEN="your-token"

curl -fsSL "${baseUrl}/medina-cli.ts" -o /tmp/medina-cli.ts
bun /tmp/medina-cli.ts status
bun /tmp/medina-cli.ts latest
bun /tmp/medina-cli.ts days 7 --header
\`\`\`

Use the CLI for common navigation and ingestion:

\`\`\`sh
bun /tmp/medina-cli.ts day today
bun /tmp/medina-cli.ts show yesterday
bun /tmp/medina-cli.ts in --wait ./voice.m4a
bun /tmp/medina-cli.ts get /recordings.json
bun /tmp/medina-cli.ts req POST /events --json '{"type":"note","text":"hello"}'
\`\`\`

CLI stdout is data-oriented for pipes; progress and HTTP status lines go to stderr.

### 2. Use the SDK — best for JS/Bun scripts

\`\`\`js
import { createMedinaClient } from "${baseUrl}/sdk.js";

const medina = createMedinaClient({
  baseUrl: "${endpoint}",
  token: process.env.MEDINA_TOKEN,
});

console.log(await medina.getStatus());
console.log(await medina.getRecordings());
console.log(await medina.getInterval("020260515"));
\`\`\`

The SDK exposes \`api\`, the typed Hono client, plus humane helpers like \`request()\`, \`json()\`, \`getStatus()\`, \`getRecordings()\`, \`getInterval(id)\`, \`createIngestDestination()\`, \`uploadIngest()\`, \`notifyUploadFinished()\`, and \`connectEvents()\`.

### 3. Use raw HTTP — best for curl/custom clients

Read the HTTP reference at \`${baseUrl}/api.md\`, then call routes directly:

\`\`\`sh
curl -H "Authorization: Bearer $MEDINA_TOKEN" "$MEDINA_ROOT/status.json"
curl -H "Authorization: Bearer $MEDINA_TOKEN" "$MEDINA_ROOT/recordings.json"
curl -H "Authorization: Bearer $MEDINA_TOKEN" "$MEDINA_ROOT/transcripts.json?limit=20&order=desc"
\`\`\`

## Authentication

Your \`MEDINA_TOKEN\` is a delegated credential for your Medina stream. Treat it like a password: do not paste it into logs, public prompts, tickets, or source files.

The CLI reads these environment variables automatically:

- \`MEDINA_ROOT\` — this server's base URL, usually \`${endpoint}\`
- \`MEDINA_TOKEN\` — bearer token for protected stream resources

HTTP bearer auth accepts:

- \`Authorization: Bearer <token>\`
- \`X-Medina-Token: <token>\`
- \`?token=<token>\`

## Useful URLs

- Agent guide: \`${baseUrl}/agents.md\`
- API reference: \`${baseUrl}/api.md\`
- SDK bundle: \`${baseUrl}/sdk.js\`
- SDK types: \`${baseUrl}/sdk.d.ts\`
- CLI: \`${baseUrl}/medina-cli.ts\`
- App: \`${baseUrl}/app\`
`;
}
