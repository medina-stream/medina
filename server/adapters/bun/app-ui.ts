import { getAppPath } from "../../app-path";

const expoDevServerUrl = process.env.EXPO_DEV_SERVER_URL;
const staticAppRoot = process.env.MEDINA_APP_STATIC_DIR ?? "./static/app";
const staticAppIndex = Bun.file(`${staticAppRoot}/index.html`);

function serveStaticApp(req: Request) {
  const url = new URL(req.url);
  const appPath = getAppPath(url);
  const assetPath = appPath.length > 0 ? `${staticAppRoot}/${appPath}` : `${staticAppRoot}/index.html`;
  const asset = Bun.file(assetPath);

  // Fall back to the exported SPA entrypoint for client-side routes.
  return asset.exists().then((exists) => (exists ? new Response(asset) : new Response(staticAppIndex)));
}

function isAppAssetPath(appPath: string) {
  if (appPath.length === 0) {
    return false;
  }

  if (appPath.startsWith("_expo/") || appPath.startsWith(".expo/") || appPath.startsWith("assets/")) {
    return true;
  }

  const lastSegment = appPath.split("/").at(-1) ?? "";
  return lastSegment.includes(".");
}

async function proxyExpoApp(req: Request, appPath: string) {
  const url = new URL(req.url);
  const upstreamPath = isAppAssetPath(appPath) ? `/${appPath}` : "/";
  const upstreamUrl = new URL(`${upstreamPath}${url.search}`, expoDevServerUrl);

  try {
    const response = await fetch(new Request(upstreamUrl, req));
    if (!response.ok && !isAppAssetPath(appPath)) {
      return serveStaticApp(req);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      const headers = new Headers(response.headers);

      // Bun fetch can hand us a decoded body while preserving upstream
      // content-encoding metadata, which breaks browser decoding.
      headers.delete("content-encoding");
      headers.delete("content-length");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  } catch {
    return serveStaticApp(req);
  }
}

export function createBunAppUiHandlers(options: { isProduction: boolean }) {
  const { isProduction } = options;
  const useExpoDevServer = !isProduction && Boolean(expoDevServerUrl);

  function serveApp(req: Request) {
    if (!useExpoDevServer) {
      return serveStaticApp(req);
    }

    const url = new URL(req.url);
    return proxyExpoApp(req, getAppPath(url));
  }

  function serveExpoAsset(req: Request) {
    const url = new URL(req.url);
    const assetPath = url.pathname.replace(/^\/+/, "");

    if (!useExpoDevServer) {
      const file = Bun.file(`${staticAppRoot}/${assetPath}`);
      return file.exists().then((exists) =>
        exists ? new Response(file) : new Response("Not Found", { status: 404 })
      );
    }

    return proxyExpoApp(req, assetPath);
  }

  return {
    serveApp,
    serveExpoAsset,
  };
}
