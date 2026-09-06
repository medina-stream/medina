/** Artifact key normalization: the pure, dependency-free half of
 * `ArtifactStore`.
 *
 * Key validation is shared by the server and by modules the browser bundle
 * imports (`lifelog/Resources.ts` defines the artifact schemas for both
 * sides). Keeping it free of Effect imports is what makes that safe:
 * `effect/Config` reads `import.meta.env`, and a classic `<script>` cannot
 * parse `import.meta` at all, so pulling it in silently breaks the client.
 * `ArtifactStore.ts` re-exports these for server callers.
 */
import { isAbsolute, join, normalize } from "node:path"

export type ArtifactKey = string & { readonly ArtifactKey: unique symbol }

export const key = (value: string): ArtifactKey => {
  const normalized = normalize(value).replace(/^\.\//, "")
  if (!value || isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`invalid artifact key: ${value}`)
  }
  return normalized as ArtifactKey
}

export const artifactPath = (root: string, value: string): string => join(root, key(value))
