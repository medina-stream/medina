/**
 * Provision the capture policy's upload section with real bucket credentials.
 *
 * Run this on the Medina host (medina-dev) in your own terminal — never paste
 * secrets into chat. The access key id is prompted visibly; the secret is
 * prompted with terminal echo disabled. Nothing secret is printed or logged.
 *
 *   DATA_DIR=/mnt/archil/medina bun scripts/capture-policy-set-upload.ts \
 *     --bucket sco-lifelog-in --prefix capture/
 *
 * Non-secret fields come from flags (shown with --help); the endpoint
 * defaults to https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com when that env
 * var is set. The policy is re-validated before it is written, and the
 * change takes effect immediately — the server reads the policy from disk
 * on every fetch, no restart needed.
 */
import { spawnSync } from "node:child_process"
import { createInterface } from "node:readline"
import { CapturePolicyStore, CapturePolicyUpload, decodePolicy } from "../lib/capture/CapturePolicy.ts"
import { dataPath } from "../lib/lifelog/Resources.ts"

const usage = `usage: bun scripts/capture-policy-set-upload.ts [options]
  --endpoint URL        S3-compatible endpoint (default: https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com)
  --bucket NAME         bucket uploads go to
  --region REGION       signing region (default: us-east-1)
  --prefix PREFIX       object-key prefix, e.g. capture/ (default: empty)
  --unmetered-only      upload on unmetered networks only (default)
  --no-unmetered-only   allow metered uploads
  --help                this text`

const parseArgs = (argv: string[]) => {
  const options: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    if (arg === "--help") return { help: true as const }
    if (arg === "--unmetered-only") { options.unmeteredOnly = true; continue }
    if (arg === "--no-unmetered-only") { options.unmeteredOnly = false; continue }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg)
    if (match) { options[match[1] as string] = match[2] as string; continue }
    if (arg.startsWith("--")) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) throw new Error(`flag ${arg} needs a value`)
      options[arg.slice(2)] = value
      index++
    } else throw new Error(`unexpected argument: ${arg}`)
  }
  return { help: false as const, options }
}

const ask = (prompt: string, secret: boolean): Promise<string> =>
  new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (secret) spawnSync("stty", ["-echo"], { stdio: "inherit" })
    readline.question(prompt, (answer) => {
      if (secret) {
        spawnSync("stty", ["echo"], { stdio: "inherit" })
        process.stdout.write("\n")
      }
      readline.close()
      resolve(answer.trim())
    })
  })

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) { console.log(usage); return }
  const { options } = parsed
  if (!process.stdin.isTTY) throw new Error("run this interactively: secrets are prompted on the terminal, never piped")

  const store = new CapturePolicyStore({ directory: dataPath("capture-policy") })
  const current = store.readPolicy()

  const endpoint = (options.endpoint as string | undefined) ??
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "") ??
    ""
  const bucket = (options.bucket as string | undefined) ?? current.upload.bucket
  const region = (options.region as string | undefined) ?? current.upload.region
  const prefix = (options.prefix as string | undefined) ?? current.upload.prefix
  const unmeteredOnly = (options.unmeteredOnly as boolean | undefined) ?? current.upload.unmeteredOnly
  if (!endpoint) throw new Error("pass --endpoint or set R2_ACCOUNT_ID")
  if (!bucket) throw new Error("pass --bucket")

  console.log(`endpoint: ${endpoint}\nbucket:   ${bucket}\nregion:   ${region}\nprefix:   ${prefix || "(none)"}\nunmetered-only: ${unmeteredOnly}`)
  const accessKeyId = await ask("access key id: ", false)
  const secretAccessKey = await ask("secret access key: ", true)
  if (!accessKeyId || !secretAccessKey) throw new Error("both credentials are required")

  const updated = decodePolicy({
    ...JSON.parse(JSON.stringify(current)),
    updatedAt: new Date().toISOString(),
    upload: new CapturePolicyUpload({ endpoint, bucket, region, prefix, accessKeyId, secretAccessKey, unmeteredOnly })
  })
  if (!updated) throw new Error("the merged policy failed validation; nothing was written")
  store.writePolicy(updated)
  console.log(`policy v${updated.version} written: upload credentials live, effective immediately`)
}

main().catch((error) => { console.error(`error: ${(error as Error).message}`); process.exit(1) })
