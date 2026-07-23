import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import {
  registerSourceDefinition,
  type Source,
  type SourceConfig,
  type SourceFactoryOptions,
  type SourceFile,
} from "../lib/source";

type FilesystemSourceConfig = SourceConfig & {
  path: string;
};

function mimeTypeForExt(ext: string): string {
  const lower = ext.toLowerCase();
  const map: Record<string, string> = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
  };
  return map[lower] ?? "application/octet-stream";
}

async function walk(dir: string, base: string, out: SourceFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out);
    } else if (entry.isFile()) {
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      const rel = relative(base, full).split(sep).join("/");
      out.push({
        id: rel,
        name: entry.name,
        mimeType: mimeTypeForExt(extname(entry.name)),
        modifiedTime: info.mtime.toISOString(),
        size: info.size,
      });
    }
  }
}

class FilesystemSource implements Source {
  readonly config: FilesystemSourceConfig;

  constructor(config: SourceConfig, _options?: SourceFactoryOptions) {
    this.config = config as FilesystemSourceConfig;
  }

  async listFiles(): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    await walk(this.config.path, this.config.path, files);
    return files;
  }

  async fetchFile(file: SourceFile): Promise<{ body: ArrayBuffer; contentType: string; filename: string }> {
    const full = join(this.config.path, file.id);
    const body = await readFile(full);
    return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, contentType: file.mimeType ?? "application/octet-stream", filename: file.name };
  }
}

registerSourceDefinition({
  type: "filesystem",
  validate(config) {
    if (typeof config.path !== "string" || !config.path.trim()) throw new Error("Filesystem source path is required.");
  },
  create: (config, options) => new FilesystemSource(config, options),
});
