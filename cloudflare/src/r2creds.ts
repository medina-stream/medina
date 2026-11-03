/**
 * R2 S3 credentials for the media stages (migration milestone 4,
 * steps 5–6 — docs/cloudflare-migration.md §4.3).
 *
 * The native R2 binding cannot presign URLs or speak S3, and the
 * media stages live on exactly that: Transloadit imports the
 * archived original from a presigned GET URL and stores chunks back
 * with Medina-minted short-lived credentials; AssemblyAI fetches a
 * presigned GET URL itself. medina-dev gets those from
 * lib/R2TempCreds.ts, whose mint calls the Cloudflare
 * temp-access-credentials API through an edge-injected token the
 * Worker does not have.
 *
 * The Worker instead carries its own bucket-scoped S3 keypair,
 * minted by the stack (Cloudflare.R2.S3Credentials in
 * alchemy.run.ts: Alchemy creates an account API token whose policy
 * covers only sco-lifelog object read/write, and injects the
 * derived S3 credentials as a secret binding). On top of that
 * keypair this module reproduces medina-dev's credential shapes
 * locally, with WebCrypto only:
 *
 *   - `presignGetUrl` — SigV4 query-signed GET URLs (the server's
 *     presignGet: 2 h TTL), signed either with the standing keypair
 *     or with a minted temporary credential.
 *   - `mintTempCredentials` — Cloudflare's documented local
 *     generation of R2 temporary credentials: an HS256 JWT signed
 *     with the parent secret access key, carrying the bucket, the
 *     scope, and the object/prefix restriction; the temporary
 *     secret is the SHA-256 hex of the signed JWT and the session
 *     token is base64("jwt/" + jwt). Local signing is documented as
 *     belonging in "a trusted environment (such as your backend or
 *     a Worker)" — this is that Worker. The outputs are the same
 *     credential triple the API mint returns medina-dev, so
 *     Transloadit receives the same shape of short-lived,
 *     prefix-scoped store credentials it does today.
 */
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";

export class R2CredsError extends Data.TaggedError("R2CredsError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The S3Credentials binding value (see alchemy.run.ts). */
export interface S3CredentialsValue {
  readonly endpoint: string;
  readonly bucketName: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Parse the ARTIFACTS_S3 binding. Deployed, it is a secret_text
 * binding holding the JSON encoding of the credentials value.
 * Anything else (missing, unparseable, wrong shape) is a stage
 * configuration error the caller reports — never a silent fallback
 * to some other credential.
 */
export const parseS3Credentials = (
  raw: unknown,
): S3CredentialsValue | null => {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const endpoint = record["endpoint"];
  const bucketName = record["bucketName"];
  const accessKeyId = record["accessKeyId"];
  const secretAccessKey = record["secretAccessKey"];
  if (
    typeof endpoint !== "string" ||
    typeof bucketName !== "string" ||
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string"
  ) {
    return null;
  }
  return {
    endpoint,
    bucketName,
    region: typeof record["region"] === "string" ? record["region"] : "auto",
    accessKeyId,
    secretAccessKey,
  };
};

/** A credential triple usable for SigV4 signing (standing or temp). */
export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (data: Uint8Array | string): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof data === "string" ? encoder.encode(data) : new Uint8Array(data),
      ),
    ),
  );

const hmac = async (
  key: Uint8Array | string,
  data: string,
): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)),
  );
};

/** RFC 3986 segment encoding (AWS canonical form). */
const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encodeKeyPath = (bucket: string, key: string): string =>
  bucket === ""
    ? `/${key.split("/").map(encodeSegment).join("/")}`
    : `/${encodeSegment(bucket)}/${key.split("/").map(encodeSegment).join("/")}`;

/**
 * SigV4 query-signed (presigned) GET URL for one object, valid for
 * `ttlSeconds`. Mirrors the semantics of medina-dev's presignGet
 * (lib/R2TempCreds.ts via @aws-sdk/s3-request-presigner): path-style
 * URL on the account S3 endpoint, host the only signed header, the
 * session token carried as a signed query parameter when the
 * credentials are temporary.
 */
export const presignGetUrl = (options: {
  readonly endpoint: string;
  readonly bucket: string;
  readonly key: string;
  readonly credentials: SigningCredentials;
  readonly ttlSeconds: number;
  readonly now?: Date;
  /** SigV4 region; R2's is "auto" (the default). */
  readonly region?: string;
}): Effect.Effect<string, R2CredsError> =>
  Effect.tryPromise({
    try: async () => {
      const now = options.now ?? new Date();
      const date = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
      const day = date.slice(0, 8);
      const region = options.region ?? "auto";
      const scope = `${day}/${region}/s3/aws4_request`;
      const url = new URL(options.endpoint);
      const host = url.host;
      url.pathname = encodeKeyPath(options.bucket, options.key);
      const params: Array<[string, string]> = [
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        [
          "X-Amz-Credential",
          `${options.credentials.accessKeyId}/${scope}`,
        ],
        ["X-Amz-Date", date],
        ["X-Amz-Expires", String(options.ttlSeconds)],
        ["X-Amz-SignedHeaders", "host"],
      ];
      if (options.credentials.sessionToken !== undefined) {
        params.push([
          "X-Amz-Security-Token",
          options.credentials.sessionToken,
        ]);
      }
      params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const canonicalQuery = params
        .map(
          ([name, value]) =>
            `${encodeSegment(name)}=${encodeSegment(value)}`,
        )
        .join("&");
      const canonicalRequest = [
        "GET",
        url.pathname,
        canonicalQuery,
        `host:${host}`,
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n");
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        date,
        scope,
        await sha256Hex(canonicalRequest),
      ].join("\n");
      const kDate = await hmac(`AWS4${options.credentials.secretAccessKey}`, day);
      const kRegion = await hmac(kDate, region);
      const kService = await hmac(kRegion, "s3");
      const kSigning = await hmac(kService, "aws4_request");
      const signature = hex(await hmac(kSigning, stringToSign));
      url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
      return url.toString();
    },
    catch: (cause) =>
      new R2CredsError({ message: "presigning an R2 GET URL failed", cause }),
  });

/** One minted temporary credential, the API mint's return shape. */
export interface TempCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

const base64Url = (data: Uint8Array | string): string => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/**
 * Mint R2 temporary credentials locally (the documented
 * client-side-signing algorithm): sign a JWT with the parent
 * secret access key — claims carry the bucket, exactly one of
 * scope/actions, and the path restriction — then derive the
 * credential triple. `parent` is the Worker's bucket keypair (its
 * access key id is the parent token's id; its secret access key is
 * that token's S3 secret).
 */
export const mintTempCredentials = (options: {
  readonly endpoint: string;
  readonly accountId: string;
  readonly parent: SigningCredentials;
  readonly bucket: string;
  readonly permission: "object-read-only" | "object-read-write";
  readonly ttlSeconds: number;
  readonly prefixes?: ReadonlyArray<string>;
  readonly objects?: ReadonlyArray<string>;
  readonly now?: Date;
}): Effect.Effect<TempCredentials, R2CredsError> =>
  Effect.tryPromise({
    try: async () => {
      const nowSeconds = Math.floor(
        (options.now ?? new Date()).getTime() / 1000,
      );
      const claims: Record<string, unknown> = {
        bucket: options.bucket,
        scope: options.permission,
      };
      if (
        options.prefixes !== undefined ||
        options.objects !== undefined
      ) {
        claims["paths"] = {
          prefixPaths: [...(options.prefixes ?? [])],
          objectPaths: [...(options.objects ?? [])],
        };
      }
      const payload = {
        ...claims,
        sub: options.accountId,
        iss: options.parent.accessKeyId,
        aud: new URL(options.endpoint).host,
        iat: nowSeconds,
        exp: nowSeconds + options.ttlSeconds,
      };
      const header = { alg: "HS256", typ: "JWT" };
      const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
      const signature = await hmac(
        options.parent.secretAccessKey,
        signingInput,
      );
      const jwt = `${signingInput}.${base64Url(signature)}`;
      return {
        accessKeyId: options.parent.accessKeyId,
        secretAccessKey: await sha256Hex(jwt),
        sessionToken: btoa(`jwt/${jwt}`),
      };
    },
    catch: (cause) =>
      new R2CredsError({
        message: "minting R2 temporary credentials failed",
        cause,
      }),
  });

/** The account id an S3 endpoint belongs to (its first DNS label). */
export const accountIdFromEndpoint = (endpoint: string): string =>
  new URL(endpoint).host.split(".")[0] ?? "";
