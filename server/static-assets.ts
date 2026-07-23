import { normalizeBucketKey } from "#lib/bucket";

const staticRoot = "./static";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

function extension(path: string) {
  const segment = path.split("/").at(-1) ?? "";
  const index = segment.lastIndexOf(".");
  return index >= 0 ? segment.slice(index).toLowerCase() : "";
}

export function staticAssetFile(pathname: string) {
  const key = normalizeBucketKey(pathname);
  if (!key || key.startsWith("../") || key.includes("/../")) return null;
  return {
    contentType: contentTypes[extension(key)] ?? "application/octet-stream",
    file: Bun.file(`${staticRoot}/${key}`),
    key,
  };
}

export async function serveStaticAsset(pathname: string) {
  const asset = staticAssetFile(pathname);
  if (!asset || !(await asset.file.exists())) return null;
  return new Response(asset.file, {
    headers: { "content-type": asset.contentType },
  });
}
