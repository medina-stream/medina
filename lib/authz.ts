export const medinaTokenHeader = "X-Medina-Token";
export const tailscaleUserLoginHeader = "Tailscale-User-Login";
export const tailscaleUserNameHeader = "Tailscale-User-Name";
export const tailscaleUserProfilePicHeader = "Tailscale-User-Profile-Pic";
export const tailscaleAuthLoginsEnvVar = "MEDINA_TAILSCALE_AUTH_LOGINS";

export type AuthMode = "public" | "token" | "token_or_tailscale" | "tailscale";

export type AuthPolicy = {
  mode: AuthMode;
  tokenEnvVar?: string;
  allowedTailscaleLogins?: string[];
};

export type AuthzDecision = {
  allowed: boolean;
  reason: "public" | "token" | "tailscale" | "missing-token" | "bad-token" | "missing-tailscale-login" | "tailscale-login-forbidden" | "misconfigured-token";
  status?: 401 | 403 | 500;
  message?: string;
};

function getEnv(name: string, env: Record<string, string | undefined> = process.env) {
  return env[name];
}

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

function parseCommaList(value = "") {
  return [...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

export function parseTailscaleAuthLogins(value = "") {
  return [...new Set(parseCommaList(value).map(normalizeLogin))];
}

function extractBasicAuthToken(headers: Headers) {
  const authorization = headers.get("authorization") ?? "";
  const basicMatch = authorization.match(/^Basic\s+(.+)$/i);
  if (!basicMatch?.[1]) {
    return null;
  }

  try {
    const decoded = atob(basicMatch[1].trim());
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }
    return decoded.slice(separatorIndex + 1).trim() || null;
  } catch {
    return null;
  }
}

export function extractMedinaToken(input: Headers | Request) {
  const headers = input instanceof Headers ? input : input.headers;
  const authorization = headers.get("authorization") ?? "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const queryToken = input instanceof Request
    ? new URL(input.url).searchParams.get("token")?.trim()
    : null;
  return bearerMatch?.[1]?.trim()
    || extractBasicAuthToken(headers)
    || headers.get(medinaTokenHeader)?.trim()
    || queryToken
    || null;
}

export function constantTimeTokenEquals(actual: string | null | undefined, expected: string | null | undefined) {
  if (!actual || !expected) return false;

  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length);
  let diff = actualBytes.length ^ expectedBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return diff === 0;
}

export function tailscaleLoginAllowed(headers: Headers, allowedLogins: string[] | undefined) {
  const login = headers.get(tailscaleUserLoginHeader);
  if (!login) {
    return { allowed: false, login: null, reason: "missing-tailscale-login" as const };
  }

  const normalizedLogin = normalizeLogin(login);
  const normalizedAllowedLogins = allowedLogins?.map(normalizeLogin).filter(Boolean) ?? [];
  if (normalizedAllowedLogins.length > 0 && !new Set(normalizedAllowedLogins).has(normalizedLogin)) {
    return { allowed: false, login, reason: "tailscale-login-forbidden" as const };
  }

  return { allowed: true, login, reason: "tailscale" as const };
}

function resolveTailscaleAllowlist(auth: AuthPolicy, env: Record<string, string | undefined>) {
  if (auth.allowedTailscaleLogins !== undefined) return auth.allowedTailscaleLogins;
  const globalValue = getEnv(tailscaleAuthLoginsEnvVar, env);
  return globalValue === undefined ? undefined : parseTailscaleAuthLogins(globalValue);
}

function tokenAllowed(auth: AuthPolicy, request: Request, env: Record<string, string | undefined>): AuthzDecision {
  const tokenEnvVar = auth.tokenEnvVar ?? "MEDINA_TOKEN";
  const expectedToken = getEnv(tokenEnvVar, env);
  if (!expectedToken) {
    return {
      allowed: false,
      message: `Stream token env var ${tokenEnvVar} is not configured.`,
      reason: "misconfigured-token",
      status: 500,
    };
  }

  const providedToken = extractMedinaToken(request);
  if (!providedToken) {
    return { allowed: false, message: "Missing Medina token.", reason: "missing-token", status: 401 };
  }

  if (!constantTimeTokenEquals(providedToken, expectedToken)) {
    return { allowed: false, message: "Invalid Medina token.", reason: "bad-token", status: 403 };
  }

  return { allowed: true, reason: "token" };
}

function tailscaleAllowed(auth: AuthPolicy, headers: Headers, env: Record<string, string | undefined>): AuthzDecision {
  const result = tailscaleLoginAllowed(headers, resolveTailscaleAllowlist(auth, env));
  if (result.allowed) return { allowed: true, reason: "tailscale" };
  if (result.reason === "tailscale-login-forbidden") {
    return {
      allowed: false,
      message: `Tailscale user ${result.login} is not allowed for this stream.`,
      reason: result.reason,
      status: 403,
    };
  }
  return {
    allowed: false,
    message: `Missing ${tailscaleUserLoginHeader} header.`,
    reason: result.reason,
    status: 401,
  };
}

export function authorizeRequest(auth: AuthPolicy, request: Request, env: Record<string, string | undefined> = process.env): AuthzDecision {
  if (request.method === "OPTIONS") return { allowed: true, reason: "public" };

  switch (auth.mode) {
    case "public":
      return { allowed: true, reason: "public" };
    case "token":
      return tokenAllowed(auth, request, env);
    case "tailscale":
      return tailscaleAllowed(auth, request.headers, env);
    case "token_or_tailscale": {
      const tokenDecision = tokenAllowed(auth, request, env);
      if (tokenDecision.allowed) return tokenDecision;

      const tailscaleDecision = tailscaleAllowed(auth, request.headers, env);
      if (tailscaleDecision.allowed) return tailscaleDecision;

      if (tokenDecision.reason === "misconfigured-token") return tailscaleDecision;
      if (tokenDecision.reason === "missing-token" && tailscaleDecision.reason !== "missing-tailscale-login") return tailscaleDecision;
      return tokenDecision;
    }
  }
}
