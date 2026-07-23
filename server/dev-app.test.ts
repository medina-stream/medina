import { expect, setDefaultTimeout, test } from "bun:test";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

setDefaultTimeout(120_000);

const serverDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(serverDir, "..");
const textDecoder = new TextDecoder();

type RunningDevServer = {
  proc: ReturnType<typeof Bun.spawn>;
  readLogs: () => string;
};

type AppHtmlResult = {
  html: string;
  scriptUrls: string[];
};

function appendLog(buffer: string[], chunk: Uint8Array) {
  buffer.push(textDecoder.decode(chunk, { stream: true }));

  const joined = buffer.join("");
  if (joined.length > 40_000) {
    buffer.splice(0, buffer.length, joined.slice(-40_000));
  }
}

function captureLogs(stream: ReadableStream<Uint8Array> | null | undefined, buffer: string[]) {
  if (!stream) {
    return Promise.resolve();
  }

  return stream
    .pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          appendLog(buffer, chunk);
        },
        close() {
          const remainder = textDecoder.decode();
          if (remainder.length > 0) {
            buffer.push(remainder);
          }
        },
      }),
    )
    .catch(() => undefined);
}

async function getAvailablePort() {
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine an available port"));
        return;
      }

      const availablePort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePort(availablePort);
      });
    });
  });

  return String(port);
}

function startDevServer(port: string): RunningDevServer {
  const logs: string[] = [];
  const proc = Bun.spawn(["bun", "dev"], {
    cwd: rootDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: port,
      MEDINA_ROOT: `http://127.0.0.1:${port}/`,
      MEDINA_APP_STATIC_DIR: appStaticFixtureDir,
      MEDINA_TOKEN: "dev-app-test-token",
      S3_BUCKET: "medina-test",
      MEDINA_SKIP_BUCKET_HEALTH: "true",
    },
  });

  void captureLogs(proc.stdout, logs);
  void captureLogs(proc.stderr, logs);

  return {
    proc,
    readLogs: () => logs.join(""),
  };
}

async function stopDevServer(devServer: RunningDevServer) {
  devServer.proc.kill("SIGTERM");

  const exitCode = await Promise.race([
    devServer.proc.exited,
    Bun.sleep(10_000).then(() => null),
  ]);

  if (exitCode === null) {
    devServer.proc.kill("SIGKILL");
    await devServer.proc.exited;
  }
}

async function waitFor<T>(label: string, callback: () => Promise<T>, logs: () => string, timeoutMs = 90_000) {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await Bun.sleep(1_000);
    }
  }

  const logOutput = logs().trim();
  const failureMessage = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(
    [`Timed out waiting for ${label}: ${failureMessage}`, logOutput.length > 0 ? `Captured logs:\n${logOutput}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function extractScriptUrls(html: string) {
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
}

async function fetchAppHtml(baseUrl: string): Promise<AppHtmlResult> {
  const response = await fetch(`${baseUrl}/app`, {
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`/app returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`/app returned ${contentType || "an unexpected content type"}`);
  }

  const html = await response.text();
  const scriptUrls = extractScriptUrls(html);
  if (scriptUrls.length === 0) {
    throw new Error("/app did not include any script tags");
  }

  const appBundleUrls = scriptUrls.filter((url): url is string => Boolean(url?.startsWith("/app/")));
  if (appBundleUrls.length === 0) {
    throw new Error("/app did not include a static script URL under /app");
  }

  return { html, scriptUrls: appBundleUrls };
}

async function fetchJavaScriptAsset(baseUrl: string, assetUrl: string) {
  const response = await fetch(new URL(assetUrl, baseUrl), {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`${assetUrl} returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("javascript")) {
    throw new Error(`${assetUrl} returned ${contentType || "an unexpected content type"}`);
  }
}

const appStaticFixtureDir = resolve(rootDir, "test-root/static-app-fixture");

function resetStaticAppFixture() {
  if (existsSync(appStaticFixtureDir)) {
    rmSync(appStaticFixtureDir, { force: true, recursive: true });
  }

  mkdirSync(appStaticFixtureDir, { recursive: true });
  mkdirSync(resolve(appStaticFixtureDir, "assets"), { recursive: true });
  writeFileSync(
    resolve(appStaticFixtureDir, "index.html"),
    `<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script src="/app/assets/test-entry.js"></script>
  </body>
</html>`,
  );
  writeFileSync(resolve(appStaticFixtureDir, "assets/test-entry.js"), "console.log('static app');\n");
}

test("bun dev serves /app HTML and JavaScript from the static export directory", async () => {
  resetStaticAppFixture();
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const devServer = startDevServer(port);

  try {
    const { html, scriptUrls } = await waitFor("the /app HTML", () => fetchAppHtml(baseUrl), devServer.readLogs);

    expect(html).toContain('id="root"');
    expect(scriptUrls.length).toBeGreaterThan(0);

    for (const scriptUrl of scriptUrls) {
      await waitFor(`the JavaScript asset ${scriptUrl}`, () => fetchJavaScriptAsset(baseUrl, scriptUrl), devServer.readLogs);
    }
  } finally {
    await stopDevServer(devServer);
  }
});
