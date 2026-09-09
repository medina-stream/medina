import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const captureId = process.argv[2]
if (!captureId) throw new Error("usage: bun scripts/pyannote-speaker-experiment.ts <capture-id> [start-seconds duration-seconds]")

const dataDir = process.env.DATA_DIR ?? "/mnt/archil/medina"
const base = "https://pyannoteai.int.exe.xyz"
const sourceCapture = "05714c74efb0494b4180cfd4f53bd8fdec5c6230367c06f5e8cb673a534a7563"
const sourceAudio = join(dataDir, "capture", sourceCapture, "sco-lifelog-020260906T104830.m4a")
const captureDir = join(dataDir, "capture", captureId)
const targetName = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: captureDir, onlyFiles: true }))).find((name) => name.endsWith(".m4a"))
if (!targetName) throw new Error(`no m4a audio for ${captureId}`)
const targetAudio = join(captureDir, targetName)

const run = async (...args: string[]) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr}`)
  return stdout
}

const targetStart = Number(process.argv[3] ?? "")
const targetDuration = Number(process.argv[4] ?? "")
const targetPath = Number.isFinite(targetStart) && Number.isFinite(targetDuration) && targetDuration > 0
  ? "/tmp/medina-pyannote-target.wav"
  : targetAudio
if (targetPath !== targetAudio) {
  await run("ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", String(targetStart), "-t", String(targetDuration), "-i", targetAudio, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", targetPath)
}

const upload = async (key: string, path: string) => {
  const init = await fetch(`${base}/v1/media/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `media://${key}` })
  }).then((r) => r.json() as Promise<{ url: string }>)
  const put = await fetch(init.url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: Bun.file(path) })
  if (!put.ok) throw new Error(`media upload failed: ${put.status}`)
  return `media://${key}`
}

const job = async (path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  const { jobId } = await response.json() as { jobId: string }
  for (;;) {
    const result = await fetch(`${base}/v1/jobs/${jobId}`).then((r) => r.json() as Promise<{ status: string; output?: unknown; error?: unknown }>)
    if (result.status === "succeeded") return result.output
    if (result.status === "failed" || result.status === "canceled") throw new Error(`${path} job failed: ${JSON.stringify(result)}`)
    await Bun.sleep(2000)
  }
}

const enrollment = process.env.PYANNOTE_ENROLLMENT ?? "/tmp/medina-scott-enrollment-composite.wav"
const enrollmentUrl = await upload(`medina-scott-enrollment-${Date.now()}`, enrollment)
const targetUrl = await upload(`medina-speaker-target-${captureId}-${Date.now()}`, targetPath)
const voiceprint = await job("/v1/voiceprint", { url: enrollmentUrl, model: "precision-2" }) as { voiceprint: string }
const output = await job("/v1/identify", {
  url: targetUrl,
  voiceprints: [{ label: "Scott", voiceprint: voiceprint.voiceprint }],
  model: "precision-2",
  confidence: true,
  turnLevelConfidence: true
})
const outDir = join(dataDir, "experiments", "pyannote-speaker-id")
await mkdir(outDir, { recursive: true })
const outputPath = join(outDir, `${captureId}${targetPath === targetAudio ? "" : `-${targetStart}-${targetDuration}`}.json`)
await Bun.write(outputPath, JSON.stringify({ provider: "pyannoteai", captureId, startSeconds: Number.isFinite(targetStart) ? targetStart : null, durationSeconds: Number.isFinite(targetDuration) ? targetDuration : null, output }, null, 2))
console.log(JSON.stringify({ captureId, outputPath, output }, null, 2))
