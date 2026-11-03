/**
 * THROWAWAY spike Worker — @yielded/auth Stage 2, increment 1b.
 *
 * Question (Scott, Nov 2): is the WASM Argon2id hasher avoidable?
 * This Worker composes the framework's password hashing WITHOUT
 * @yielded/auth-platform-workerd — no WASM anywhere — from vendor
 * parts only:
 *
 *   PasswordHashing.layer(defaultScryptPasswordHashingConfig)
 *     provided by Layer.mergeAll(
 *       @yielded/auth/WebCrypto.layer        (SecureRandom/Digest/Mac…)
 *       effect/crypto/Kdf.layerWebCrypto     (HKDF/PBKDF2; no Argon2id)
 *       @yielded/auth/PasswordScrypt.layer   (Scrypt via node:crypto)
 *       @yielded/auth KdfAdmission.layer()   (bounded KDF admission)
 *     )
 *
 * One fetch runs: scrypt hash → verify(correct) / verify(wrong)
 * round-trip through the framework's PasswordHashing service, plus a
 * WebCrypto PBKDF2 probe against the public RFC test vector
 * (PBKDF2-HMAC-SHA256, "password"/"salt", 1 iteration). The response
 * carries only booleans and PHC algorithm/parameter prefixes — never
 * a password, salt, or derived hash.
 *
 * Deployed on its own Alchemy stack/stage (MedinaAuthSpike/spike).
 * NOT medina-api; never point production traffic at it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Kdf from "effect/crypto/Kdf";
import {
  KdfAdmission,
  PasswordHashing,
  defaultScryptPasswordHashingConfig,
} from "@yielded/auth/Password";
import * as PasswordScrypt from "@yielded/auth/PasswordScrypt";
import * as WebCrypto from "@yielded/auth/WebCrypto";

// A test-only password for the round-trip. Not a real credential.
const TEST_PASSWORD = "auth-spike-round-trip";

const platform = Layer.mergeAll(
  WebCrypto.layer,
  Kdf.layerWebCrypto,
  PasswordScrypt.layer,
  KdfAdmission.layer(),
);

const hashingLayer = PasswordHashing.layer(
  defaultScryptPasswordHashingConfig,
).pipe(Layer.provideMerge(platform));

const scryptProgram = Effect.gen(function* () {
  const hashing = yield* PasswordHashing;
  const verifier = yield* hashing.hash(Redacted.make(TEST_PASSWORD));
  const correct = yield* hashing.verify(Redacted.make(TEST_PASSWORD), verifier);
  const wrong = yield* hashing.verify(
    Redacted.make("auth-spike-WRONG"),
    verifier,
  );
  const encoded = Redacted.value(verifier);
  return {
    // "$scrypt$ln=14,r=8,p=5" — algorithm + cost parameters only;
    // the salt and hash segments are deliberately dropped.
    phcPrefix: encoded.split("$").slice(0, 3).join("$"),
    correctMatches: correct.matches,
    correctNeedsRehash: correct.needsRehash,
    wrongMatches: wrong.matches,
  };
}).pipe(Effect.provide(hashingLayer));

/** WebCrypto PBKDF2 against the well-known public test vector:
 * PBKDF2-HMAC-SHA256(password="password", salt="salt", c=1, dkLen=32)
 * = 120fb6cffcf8b32c43e7225256c4f837a86548c9… (RFC 7914 §11). */
const pbkdf2Probe = async (): Promise<{
  ok: boolean;
  matchesKnownVector?: boolean;
  error?: string;
}> => {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode("salt"),
        iterations: 1,
      },
      key,
      256,
    );
    const hex = [...new Uint8Array(bits)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return {
      ok: true,
      matchesKnownVector: hex.startsWith("120fb6cffcf8b32c43e7225256c4f837"),
    };
  } catch (cause) {
    return { ok: false, error: String(cause).slice(0, 300) };
  }
};

const section = <A>(program: Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    program.pipe(
      Effect.map((result) => ({ ok: true as const, ...result })),
      Effect.catchCause((cause) =>
        Effect.succeed({ ok: false as const, error: String(cause).slice(0, 500) }),
      ),
    ),
  );

export default {
  async fetch(): Promise<Response> {
    const [scrypt, pbkdf2] = await Promise.all([
      section(scryptProgram),
      pbkdf2Probe(),
    ]);
    const body = { scrypt, pbkdf2 };
    return new Response(JSON.stringify(body), {
      status: scrypt.ok && pbkdf2.ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  },
};
