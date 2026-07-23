export type LocationPointFacts = {
  eventTime: string;
  latitude: number;
  longitude: number;
  speed: number | null;
};

export type TriageContentKind = "audio" | "av-candidate" | "image" | "location-point" | "text" | "unknown";

export type IngestClassification =
  | { confidence: number; facts: LocationPointFacts; kind: "location-point" }
  | { confidence: number; evidence: "content-type" | "extension" | "magic-bytes"; kind: "audio" }
  | { confidence: number; evidence: "content-type" | "extension" | "magic-bytes"; kind: "av-candidate" }
  | { confidence: number; evidence: "content-type" | "extension" | "magic-bytes"; kind: "image" }
  | { confidence: number; evidence: "content-type" | "extension"; kind: "text" }
  | { confidence: 0; kind: "unknown" };

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const audioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const avExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const imageExtensions = new Set([".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"]);
const textExtensions = new Set([".csv", ".json", ".md", ".txt"]);
const textContentTypes = new Set([
  "application/csv",
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/x-www-form-urlencoded",
]);

function parseNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTime(value: string | null) {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toBytes(body: ArrayBuffer | ArrayBufferView | string) {
  if (typeof body === "string") return textEncoder.encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function normalizeContentType(contentType?: string | null) {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function getFileExtension(fileName?: string | null) {
  if (!fileName) return "";
  const baseName = fileName.split(/[\\/]/).at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot >= 0 ? baseName.slice(dot).toLowerCase() : "";
}

function isTextContentType(contentType: string) {
  return contentType.startsWith("text/") || textContentTypes.has(contentType);
}

function classifyByContentType(contentType: string): IngestClassification | null {
  if (!contentType || contentType === "application/octet-stream" || contentType === "application/pdf") return null;
  if (contentType.startsWith("audio/")) return { confidence: 0.9, evidence: "content-type", kind: "audio" };
  if (contentType.startsWith("video/")) return { confidence: 0.9, evidence: "content-type", kind: "av-candidate" };
  if (contentType.startsWith("image/")) return { confidence: 0.9, evidence: "content-type", kind: "image" };
  if (isTextContentType(contentType)) return { confidence: 0.8, evidence: "content-type", kind: "text" };
  return null;
}

function classifyByExtension(extension: string): IngestClassification | null {
  if (!extension || extension === ".pdf") return null;
  if (audioExtensions.has(extension)) return { confidence: 0.85, evidence: "extension", kind: "audio" };
  if (avExtensions.has(extension)) return { confidence: 0.85, evidence: "extension", kind: "av-candidate" };
  if (imageExtensions.has(extension)) return { confidence: 0.85, evidence: "extension", kind: "image" };
  if (textExtensions.has(extension)) return { confidence: 0.75, evidence: "extension", kind: "text" };
  return null;
}

function classifyByMagicBytes(bytes: Uint8Array): Extract<IngestClassification, { evidence: "magic-bytes" }> | null {
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const ascii = (offset: number, value: string) => offset + value.length <= bytes.length
    && value.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));

  if (startsWith(0xff, 0xd8, 0xff)
    || startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    || startsWith(0x47, 0x49, 0x46, 0x38)
    || (ascii(0, "RIFF") && ascii(8, "WEBP"))) {
    return { confidence: 0.95, evidence: "magic-bytes", kind: "image" };
  }

  if (startsWith(0x49, 0x44, 0x33)
    || ascii(0, "fLaC")
    || ascii(0, "OggS")
    || (ascii(0, "RIFF") && ascii(8, "WAVE"))
    || (bytes[0] === 0xff && bytes.length > 1 && (bytes[1]! & 0xf6) === 0xf0)) {
    return { confidence: 0.95, evidence: "magic-bytes", kind: "audio" };
  }

  if (ascii(4, "ftyp")
    || startsWith(0x1a, 0x45, 0xdf, 0xa3)
    || (ascii(0, "RIFF") && ascii(8, "AVI "))) {
    return { confidence: 0.95, evidence: "magic-bytes", kind: "av-candidate" };
  }

  return null;
}

export function parseLocationPointBody(body: ArrayBuffer | ArrayBufferView | string): LocationPointFacts | null {
  const bytes = toBytes(body);
  const params = new URLSearchParams(textDecoder.decode(bytes).trim());
  const latitude = parseNumber(params.get("lat") ?? params.get("latitude"));
  const longitude = parseNumber(params.get("lon") ?? params.get("lng") ?? params.get("longitude"));
  const time = parseTime(params.get("time") ?? params.get("t") ?? params.get("timestamp"));

  if (latitude === null || longitude === null || !time) return null;

  return {
    eventTime: time.toISOString(),
    latitude,
    longitude,
    speed: parseNumber(params.get("s") ?? params.get("spd") ?? params.get("speed")),
  };
}

export function classifyIngest(input: {
  body?: ArrayBuffer | ArrayBufferView | string;
  contentType?: string | null;
  fileName?: string | null;
}): IngestClassification {
  const contentType = normalizeContentType(input.contentType);
  const extension = getFileExtension(input.fileName);
  const body = input.body === undefined ? undefined : toBytes(input.body);
  const locationCandidate = contentType === ""
    || contentType === "application/octet-stream"
    || contentType === "application/x-www-form-urlencoded"
    || contentType.startsWith("text/");

  if (body && body.byteLength <= 64 * 1024 && locationCandidate) {
    const location = parseLocationPointBody(body);
    if (location) return { confidence: 1, facts: location, kind: "location-point" };
  }

  if (body) {
    const byMagic = classifyByMagicBytes(body);
    if (byMagic) return byMagic;
  }

  const byContentType = classifyByContentType(contentType);
  if (byContentType) return byContentType;

  const byExtension = classifyByExtension(extension);
  if (byExtension) return byExtension;

  return { confidence: 0, kind: "unknown" };
}
