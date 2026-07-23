import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

const MAX_HISTORY = 10;

function getDefaultServerUrl(): string {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location.origin) {
    return normalizeServerUrl(window.location.origin);
  }

  return "";
}

export type Settings = {
  serverUrl: string;
  token: string;
  history: string[];
};

function getSettingsFile(): File {
  return new File(Paths.document, "settings.json");
}

const WEB_STORAGE_KEY = "medina-settings";

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return getDefaultServerUrl();
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  const url = new URL(withScheme);
  url.hash = "";
  if (url.pathname === "/") {
    url.pathname = "";
  }
  return url.toString().replace(/\/$/, "");
}

export function getServerLabel(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getMedinaAuthHeaders(token = loadSettings().token): Record<string, string> {
  const trimmed = normalizeToken(token);
  if (!trimmed) return {};
  return {
    Authorization: `Bearer ${trimmed}`,
    "X-Medina-Token": trimmed,
  };
}

export function loadSettings(): Settings {
  if (Platform.OS === "web") {
    try {
      const raw = localStorage.getItem(WEB_STORAGE_KEY);
      const defaultServerUrl = getDefaultServerUrl();
      if (!raw) return { serverUrl: defaultServerUrl, token: "", history: [] };
      const parsed = JSON.parse(raw) as { serverUrl?: unknown; token?: unknown; history?: unknown };
      const serverUrl = typeof parsed.serverUrl === "string" ? normalizeServerUrl(parsed.serverUrl) : defaultServerUrl;
      const token = normalizeToken(parsed.token);
      const history = Array.isArray(parsed.history) ? parsed.history.filter((e): e is string => typeof e === "string") : [];
      return { serverUrl, token, history };
    } catch {
      return { serverUrl: getDefaultServerUrl(), token: "", history: [] };
    }
  }
  try {
    const file = getSettingsFile();
    if (!file.exists) {
      return { serverUrl: getDefaultServerUrl(), token: "", history: [] };
    }

    const raw = JSON.parse(file.textSync()) as {
      serverUrl?: unknown;
      hostname?: unknown;
      token?: unknown;
      history?: unknown;
    };

    const serverUrl =
      typeof raw.serverUrl === "string"
        ? normalizeServerUrl(raw.serverUrl)
        : typeof raw.hostname === "string"
          ? normalizeServerUrl(raw.hostname)
          : getDefaultServerUrl();

    const history = Array.isArray(raw.history)
      ? raw.history
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map(normalizeServerUrl)
      : [];

    const token = normalizeToken(raw.token);

    return { serverUrl, token, history };
  } catch {
    return { serverUrl: getDefaultServerUrl(), token: "", history: [] };
  }
}

export function saveSettings(serverUrlInput: string, tokenInput?: string): Settings {
  const prev = loadSettings();
  const serverUrl = normalizeServerUrl(serverUrlInput);
  const token = tokenInput === undefined ? prev.token : normalizeToken(tokenInput);
  const history = [
    serverUrl,
    ...prev.history.filter((entry) => entry !== serverUrl),
  ].slice(0, MAX_HISTORY);
  const settings = { serverUrl, token, history };
  if (Platform.OS === "web") {
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(settings));
    return settings;
  }
  const file = getSettingsFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(settings));
  return settings;
}

export function getServerUrl(): string {
  return loadSettings().serverUrl;
}

export function getMedinaToken(): string {
  return loadSettings().token;
}
