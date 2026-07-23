import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type AudioFixtureOptions = {
  outDir: string;
  prefix?: string;
  text?: string;
};

export type AudioFixtureResult = {
  frequencies: number[];
  outputPath: string;
  probe: unknown;
  signature: string;
  speech: string;
  spokenTime: string;
};

function run(command: string[]) {
  const proc = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  if (proc.status !== 0) {
    throw new Error([
      `Command failed: ${command.join(" ")}`,
      proc.stderr?.trim(),
      proc.stdout?.trim(),
    ].filter(Boolean).join("\n"));
  }

  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

export function assertAudioFixtureDependencies() {
  run(["ffmpeg", "-hide_banner", "-version"]);
  const filters = run(["ffmpeg", "-hide_banner", "-filters"]);
  if (!filters.stdout.includes(" flite ") && !filters.stderr.includes(" flite ")) {
    throw new Error("This ffmpeg build does not include the flite text-to-speech filter.");
  }
}

function stampForFilename(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safePrefix(prefix: string) {
  return prefix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "audio-fixture";
}

export function generateAudioFixture(options: AudioFixtureOptions): AudioFixtureResult {
  assertAudioFixtureDependencies();
  mkdirSync(options.outDir, { recursive: true });

  const now = new Date();
  const signature = randomBytes(3).toString("hex").toUpperCase();
  const filename = `${safePrefix(options.prefix ?? "medina-audio-fixture")}-${stampForFilename(now)}-${signature}.wav`;
  const outputPath = resolve(options.outDir, filename);

  const spokenTime = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(now);

  const speech = options.text ?? `Medina ingest test. The current time is ${spokenTime}. Fixture signature ${signature}.`;
  const speechFile = resolve(tmpdir(), `medina-fixture-speech-${process.pid}-${signature}.txt`);
  writeFileSync(speechFile, speech);

  const seed = Number.parseInt(signature, 16);
  const frequencies = [
    520 + (seed % 240),
    760 + ((seed >> 3) % 280),
    1040 + ((seed >> 6) % 360),
  ];

  try {
    const filter = [
      `sine=frequency=${frequencies[0]}:duration=0.16:sample_rate=48000,afade=t=out:st=0.12:d=0.04,adelay=0|0[ch0]`,
      `sine=frequency=${frequencies[1]}:duration=0.18:sample_rate=48000,afade=t=out:st=0.13:d=0.05,adelay=110|110[ch1]`,
      `sine=frequency=${frequencies[2]}:duration=0.22:sample_rate=48000,afade=t=out:st=0.16:d=0.06,adelay=250|250[ch2]`,
      `[ch0][ch1][ch2]amix=inputs=3:duration=longest,volume=0.35,apad=pad_dur=0.25,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[chime]`,
      `flite=textfile=${speechFile}:voice=kal,volume=1.4,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[voice]`,
      `[chime][voice]concat=n=2:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[out]`,
    ].join(";");

    run([
      "ffmpeg",
      "-hide_banner",
      "-y",
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-metadata",
      `title=Medina audio ingest fixture ${signature}`,
      "-metadata",
      `comment=${speech}`,
      outputPath,
    ]);
  } finally {
    if (existsSync(speechFile)) {
      unlinkSync(speechFile);
    }
  }

  const probe = run([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_name,sample_rate,channels",
    "-of",
    "json",
    outputPath,
  ]);

  return {
    outputPath,
    signature,
    spokenTime,
    speech,
    frequencies,
    probe: JSON.parse(probe.stdout),
  };
}
