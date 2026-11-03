# Auth Stage 2 spike — password hasher on workerd (Nov 2, 2026)

Question: @yielded/auth's workerd platform package ships a WASM
Argon2id build. Scott's direction: prefer a boring, platform-native
hash — the dumbest respectable auth that lets us evaluate the
library. Two candidate wirings were built and run in workerd
(deployed to the scratch stack `MedinaAuthSpike`, stage `spike`,
worker `medinaauthspike-spike-spike-*` — never medina-api):

## Verdict 1 (PRIMARY): node:crypto scrypt via the framework's own parts — WORKS, no WASM

The hasher is a replaceable port stack in the framework, not a
hard-wired Argon2:

- `PasswordHashing` is built from services: effect's `Kdf.Kdf`,
  the framework's `Scrypt` service, `KdfAdmission`, `SecureRandom`.
- Which algorithm creates new hashes is config:
  `PasswordHashingConfig.scrypt` present → scrypt (the framework
  ships `defaultScryptPasswordHashingConfig`, OWASP N=16384, r=8,
  p=5); absent → Argon2id via Kdf. Verify dispatches on the stored
  PHC format (`$argon2id$…` / `$scrypt$…` / legacy PBKDF2).
- The framework core package itself ships the scrypt backend,
  `@yielded/auth/PasswordScrypt`, implemented on `node:crypto`'s
  `crypto.scrypt`, fail-closed if the function is absent. The
  workerd platform package uses this same layer.
- effect's own `Kdf.layerWebCrypto` covers HKDF/PBKDF2; the
  platform package's only Kdf contribution is wrapping it to add
  Argon2id (its `internal/kdf.ts` delegates everything else).

So the platform package is not needed for a scrypt deployment.
Composition used by this spike's final worker.ts (all vendor parts,
zero custom crypto plumbing):

```ts
import * as Kdf from "effect/crypto/Kdf";
import {
  KdfAdmission,
  PasswordHashing,
  defaultScryptPasswordHashingConfig,
} from "@yielded/auth/Password";
import * as PasswordScrypt from "@yielded/auth/PasswordScrypt";
import * as WebCrypto from "@yielded/auth/WebCrypto";

const platform = Layer.mergeAll(
  WebCrypto.layer,          // SecureRandom / Digest / Mac / Aead / Signature (WebCrypto)
  Kdf.layerWebCrypto,       // effect Kdf: HKDF + PBKDF2 (no Argon2id)
  PasswordScrypt.layer,     // Scrypt service over node:crypto
  KdfAdmission.layer(),     // bounded KDF admission (concurrency 1)
);
const hashingLayer = PasswordHashing
  .layer(defaultScryptPasswordHashingConfig)
  .pipe(Layer.provideMerge(platform));
```

Evidence (live fetch against the deployed spike Worker):

```json
{"scrypt":{"ok":true,"phcPrefix":"$scrypt$ln=14,r=8,p=5","correctMatches":true,"correctNeedsRehash":false,"wrongMatches":false},
 "pbkdf2":{"ok":true,"matchesKnownVector":true}}
```

- hash → `$scrypt$ln=14,r=8,p=5$…`; verify(correct) = true;
  verify(wrong) = false; `dummy`/rehash paths use the same derive.
- Bundle output for this build: `worker.js` (+ map, analyzer) and
  **no `.wasm` asset at all** — nothing to upload as CompiledWasm.
- One caveat to know: `PasswordHashing.make` still *requires* a
  `Kdf.Kdf` service in context (argon2 derive is only invoked for
  `$argon2id$` verifiers, which a greenfield scrypt deployment
  never creates). `Kdf.layerWebCrypto` satisfies it; an argon2
  verifier would fail closed as PasswordHashingUnavailable.

## Verdict 2 (FALLBACK): platform package WASM Argon2id as shipped — WORKS

The same spike stack first ran `WorkerdServices.layer` from
@yielded/auth-platform-workerd unchanged. Evidence:

```json
{"ok":true,"phcPrefix":"$argon2id$v=19$m=19456,t=2,p=1","correctMatches":true,"correctNeedsRehash":false,"wrongMatches":false}
```

- Bundle contained `assets/argon2-BQbbPeCg.wasm`, byte-identical
  (md5 `7cb472155da70a8702f3e3e01488eaad`) to the package's
  `dist/internal/argon2.wasm`; the bundled worker.js retains
  `import t from "./assets/argon2-BQbbPeCg.wasm"`.
- How Alchemy does it, for the integration step if ever needed:
  rolldown (via @alchemy.run/cloudflare-runtime) emits `.wasm`
  imports as separate bundle assets and leaves the import in the
  entry; Alchemy uploads extra bundle files under its default
  module rules — `CompiledWasm` for `**/*.wasm` — and workerd
  resolves the default export as a `WebAssembly.Module`. No
  moduleTypes override, no custom plugin, no wrangler config.
  Required Worker settings are the production ones already in
  cloudflare/alchemy.run.ts: compatibility date 2026-10-13 +
  `nodejs_compat`.

## WebCrypto PBKDF2 (last-resort note)

Available and correct in workerd: `crypto.subtle.deriveBits` with
PBKDF2/HMAC-SHA-256 reproduces the RFC 7914 test vector
(password/salt, c=1) — probed live above (`matchesKnownVector`).
But it is not a framework-supported primary hasher: PasswordHashing
only *verifies* legacy PBKDF2 verifiers (rehashing them to the
configured algorithm on sign-in); it never creates them. Ranking
for this single-user deployment: **scrypt (picked) > WASM Argon2id
(framework default, proven) > PBKDF2 (not creatable via the
framework)**.

## Pick

**node:crypto scrypt** through the composition in Verdict 1:
platform-native, framework-supported, no WASM in the bundle, and
the least code of any option. The WASM path stays as the proven
fallback if scrypt ever regresses under nodejs_compat.

## Reproduce / teardown

```sh
# deploy the scratch spike (from this directory)
python3 ~/workspace/bin/cf_env_run.py ~/workspace/medina-auth/cloudflare/spike \
  /opt/hatch-image/bin/bun x alchemy deploy --stage spike --yes
curl https://medinaauthspike-spike-spike-<suffix>.alignlabs.workers.dev/

# teardown
python3 ~/workspace/bin/cf_env_run.py ~/workspace/medina-auth/cloudflare/spike \
  /opt/hatch-image/bin/bun x alchemy destroy --stage spike --yes
```

The deployed spike Worker was destroyed after the evidence above
was captured.
