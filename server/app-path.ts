export function getAppPath(url: URL) {
  const normalizedPath = url.pathname.replace(/^\/+/, "");
  return normalizedPath.replace(/^app(?:\/|$)/, "");
}
