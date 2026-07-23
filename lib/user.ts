import { extractMedinaToken, tailscaleUserLoginHeader, tailscaleUserNameHeader, tailscaleUserProfilePicHeader } from "./authz";

export const defaultProfilePicUrl = "/default-profile.jpg";
export type UserAuthMethod = "tailscale" | "token" | "agent";

export type UserCredential =
  | { type: "email"; value: string }
  | { type: "phone"; value: string }
  | { type: "tailscale"; value: string };

export type UserToken = { token: string; label?: string };

export type User = {
  username: string;
  profile_pic_url: string;
  credentials: UserCredential[];
  tokens: UserToken[];
};

export type CurrentUser = User & { auth_method: UserAuthMethod };

function text(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function required(name: string, env: Record<string, string | undefined>) {
  const value = text(env[name]);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function split(value: string | undefined) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function userFromEnv(env: Record<string, string | undefined> = process.env): User {
  return {
    username: text(env.MEDINA_USERNAME) ?? text(env.MEDINA_USER_USERNAME) ?? "default",
    profile_pic_url: text(env.MEDINA_PROFILE_PIC_URL) ?? text(env.MEDINA_USER_PROFILE_PIC_URL) ?? defaultProfilePicUrl,
    credentials: [
      ...split(env.MEDINA_EMAILS ?? env.MEDINA_USER_EMAILS ?? env.MEDINA_USER_EMAIL).map((value) => ({ type: "email" as const, value })),
      ...split(env.MEDINA_PHONES ?? env.MEDINA_USER_PHONES ?? env.MEDINA_USER_PHONE).map((value) => ({ type: "phone" as const, value })),
      ...split(env.MEDINA_TAILSCALE_IDS ?? env.MEDINA_USER_TAILSCALE_IDS ?? env.MEDINA_TAILSCALE_AUTH_LOGINS).map((value) => ({ type: "tailscale" as const, value })),
    ],
    tokens: [{ label: "default", token: required("MEDINA_TOKEN", env) }],
  };
}

export function isValidUser(user: User): boolean {
  return !!text(user.username) && !!text(user.profile_pic_url);
}

function withMethod(user: User, auth_method: UserAuthMethod): CurrentUser {
  return { ...user, auth_method };
}

export function userFromRequest(request: Request, users: User[]): CurrentUser | null {
  const login = request.headers.get(tailscaleUserLoginHeader);
  if (login) {
    const matched = users.find((user) => user.credentials.some((credential) => credential.type === "tailscale" && credential.value.toLowerCase() === login.toLowerCase()));
    if (matched) return withMethod(matched, "tailscale");
    return withMethod({
      username: request.headers.get(tailscaleUserNameHeader) ?? login,
      profile_pic_url: request.headers.get(tailscaleUserProfilePicHeader) ?? defaultProfilePicUrl,
      credentials: [{ type: "tailscale", value: login }],
      tokens: [],
    }, "tailscale");
  }

  const secret = extractMedinaToken(request);
  if (!secret) return null;

  for (const user of users) {
    if (user.tokens.some((token) => token.token === secret)) return withMethod(user, "token");
  }

  return null;
}
