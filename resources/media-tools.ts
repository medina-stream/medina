type StaticFfprobeModule = { path?: string };

function resolveOptionalPackage(name: string): string | null {
  try {
    return require.resolve(name);
  } catch {
    return null;
  }
}

function readFfmpegStaticPath(): string | null {
  const resolved = resolveOptionalPackage("ffmpeg-static");
  if (!resolved) return null;
  return require(resolved) as string;
}

function readFfprobeStaticPath(): string | null {
  const resolved = resolveOptionalPackage("ffprobe-static");
  if (!resolved) return null;
  const mod = require(resolved) as StaticFfprobeModule;
  return typeof mod.path === "string" ? mod.path : null;
}

export function getFfmpegCommand() {
  return process.env.FFMPEG_PATH || readFfmpegStaticPath() || "ffmpeg";
}

export function getFfprobeCommand() {
  return process.env.FFPROBE_PATH || readFfprobeStaticPath() || "ffprobe";
}
