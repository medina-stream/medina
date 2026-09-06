import { createHash } from "node:crypto"

/** Content identity and basis hashes throughout the pipeline. */
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
