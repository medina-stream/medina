import { normalizeBucketKey } from "./bucket";

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error(`Invalid encoded orchestration key segment: ${value}`);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeOrchestrationKeySegment(value: string) {
  return toBase64Url(new TextEncoder().encode(normalizeBucketKey(value)));
}

export function decodeOrchestrationKeySegment(value: string) {
  if (!value || /[^A-Za-z0-9_-]/.test(value)) {
    throw new Error(`Invalid encoded orchestration key segment: ${value}`);
  }

  return normalizeBucketKey(new TextDecoder().decode(fromBase64Url(value)));
}

export function triageKey(ingestKey: string) {
  return normalizeBucketKey(`triage/${encodeOrchestrationKeySegment(ingestKey)}.json`);
}

export function dispatchGroupPrefix(handlerName: string, groupKey: string) {
  return normalizeBucketKey(`dispatch-index/${normalizeBucketKey(handlerName)}/${encodeOrchestrationKeySegment(groupKey)}/`);
}

export function dispatchMembershipKey(handlerName: string, groupKey: string, sourceTriageKey: string) {
  return normalizeBucketKey(`${dispatchGroupPrefix(handlerName, groupKey)}${encodeOrchestrationKeySegment(sourceTriageKey)}.json`);
}

export function dispatchStateKey(ingestKey: string) {
  return normalizeBucketKey(`dispatch-state/${encodeOrchestrationKeySegment(ingestKey)}.json`);
}
