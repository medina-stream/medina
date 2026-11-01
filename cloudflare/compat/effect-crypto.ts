/**
 * Compatibility shim for `effect/Crypto`.
 *
 * Effect 4.0.x shipped a platform `Crypto` service at `effect/Crypto`
 * (secure random bytes + SHA digests, with derived UUID/ULID helpers).
 * Effect 4.1 removed that module in favor of the `effect/crypto`
 * family, but Alchemy (beta.83/beta.84) still imports `effect/Crypto`
 * — one value import in its OAuth flow — so the deploy CLI cannot
 * start on effect 4.1 without it.
 *
 * This module is a faithful port of effect 4.0.5's `dist/Crypto.js`
 * (interface + `make` constructor, helpers vendored from the matching
 * internal modules), wired through tsconfig `paths` so only the
 * deploy toolchain sees it. Nothing in the Worker bundle imports it.
 *
 * The service is implemented by `make` from two primitives; a
 * WebCrypto-backed layer is exported for any caller that wants to
 * provide the service.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

const TypeId: "~effect/Crypto" = "~effect/Crypto";

export interface Crypto {
  readonly [TypeId]: typeof TypeId;
  nextIntUnsafe(): number;
  nextDoubleUnsafe(): number;
  randomBytes(size: number): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  digest(
    algorithm: DigestAlgorithm,
    data: Uint8Array,
  ): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  readonly random: Effect.Effect<number>;
  readonly randomBoolean: Effect.Effect<boolean>;
  readonly randomInt: Effect.Effect<number>;
  randomBetween(min: number, max: number): Effect.Effect<number>;
  randomIntBetween(
    min: number,
    max: number,
    options?: { readonly halfOpen?: boolean | undefined },
  ): Effect.Effect<number>;
  randomShuffle<A>(elements: Iterable<A>): Effect.Effect<Array<A>>;
  randomUUIDv4(options?: {
    readonly format?: "hex" | undefined;
  }): Effect.Effect<string, PlatformError.PlatformError>;
  randomUUIDv4<Format extends "hex" | "bytes">(options: {
    readonly format: Format;
  }): Effect.Effect<Format extends "bytes" ? Uint8Array : string, PlatformError.PlatformError>;
  randomUUIDv4(options?: {
    readonly format?: "hex" | "bytes" | undefined;
  }): Effect.Effect<string | Uint8Array, PlatformError.PlatformError>;
  randomUUIDv7(options?: {
    readonly format?: "hex" | undefined;
  }): Effect.Effect<string, PlatformError.PlatformError>;
  randomUUIDv7<Format extends "hex" | "bytes">(options: {
    readonly format: Format;
  }): Effect.Effect<Format extends "bytes" ? Uint8Array : string, PlatformError.PlatformError>;
  randomUUIDv7(options?: {
    readonly format?: "hex" | "bytes" | undefined;
  }): Effect.Effect<string | Uint8Array, PlatformError.PlatformError>;
  readonly randomULID: Effect.Effect<string, PlatformError.PlatformError>;
}

export const Crypto: Context.Service<Crypto, Crypto> = Context.Service<Crypto>("effect/Crypto");

// ---------------------------------------------------------------------------
// Helpers vendored from effect's internal modules (identical logic).
// ---------------------------------------------------------------------------

const nextBetween = (min: number, max: number, draw: number): number => {
  const value = draw * (max - min) + min;
  if (value !== max || min >= max || !Number.isFinite(max)) {
    return value;
  }
  if (max === 0) {
    return -Number.MIN_VALUE;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, max);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, max > 0 ? bits - BigInt(1) : bits + BigInt(1));
  return view.getFloat64(0);
};

const hexTable: ReadonlyArray<string> = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, "0"),
);

const uuidStringify = (bytes: Uint8Array): string =>
  hexTable[bytes[0]] + hexTable[bytes[1]] + hexTable[bytes[2]] + hexTable[bytes[3]] + "-" +
  hexTable[bytes[4]] + hexTable[bytes[5]] + "-" +
  hexTable[bytes[6]] + hexTable[bytes[7]] + "-" +
  hexTable[bytes[8]] + hexTable[bytes[9]] + "-" +
  hexTable[bytes[10]] + hexTable[bytes[11]] + hexTable[bytes[12]] + hexTable[bytes[13]] +
  hexTable[bytes[14]] + hexTable[bytes[15]];

const v4Bytes = (bytes: Uint8Array): Uint8Array => {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
};

const maxV7Timestamp = 2 ** 48 - 1;

const v7Bytes = (timestampMillis: number, bytes: Uint8Array): Uint8Array => {
  const timestamp = Math.min(Math.max(0, Math.trunc(timestampMillis)), maxV7Timestamp);
  bytes[0] = Math.floor(timestamp / 2 ** 40);
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
};

const base32Chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const ulidString = (timestampMillis: number, bytes: Uint8Array): string => {
  if (bytes.length !== 10) {
    throw new Error(`ULID randomness must be exactly 10 bytes, received ${bytes.length}`);
  }
  const timestamp = Math.min(Math.max(0, Math.trunc(timestampMillis)), maxV7Timestamp);
  let out = "";
  for (let shift = 45; shift >= 0; shift -= 5) {
    out += base32Chars[Math.floor(timestamp / 2 ** shift) & 0x1f];
  }
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += base32Chars[(accumulator >>> bits) & 0x1f];
    }
    accumulator &= (1 << bits) - 1;
  }
  return out;
};

// ---------------------------------------------------------------------------
// The `make` constructor, ported from effect 4.0.5's Crypto module.
// ---------------------------------------------------------------------------

export const make: (impl: {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly digest: (
    algorithm: DigestAlgorithm,
    data: Uint8Array,
  ) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
}) => Crypto = (impl) => {
  const randomBytesUnsafe = impl.randomBytes;
  const randomBytes = (size: number) =>
    Effect.map(validateSize("randomBytes", size), randomBytesUnsafe);
  const readUint53 = (bytes: Uint8Array) =>
    (bytes[0] & 0x1f) * 2 ** 48 + bytes[1] * 2 ** 40 + bytes[2] * 2 ** 32 +
    bytes[3] * 2 ** 24 + bytes[4] * 2 ** 16 + bytes[5] * 2 ** 8 + bytes[6];
  const nextDoubleUnsafe = () => readUint53(randomBytesUnsafe(7)) / 2 ** 53;
  const nextIntUnsafe = () => {
    while (true) {
      const bytes = randomBytesUnsafe(7);
      const value = readUint53(bytes);
      if ((bytes[0] & 0x20) === 0) {
        return value + Number.MIN_SAFE_INTEGER;
      }
      if (value < Number.MAX_SAFE_INTEGER) {
        return value + 1;
      }
    }
  };
  return Crypto.of({
    [TypeId]: TypeId,
    randomBytes,
    nextDoubleUnsafe,
    nextIntUnsafe,
    digest: impl.digest,
    random: Effect.sync(() => nextDoubleUnsafe()),
    randomBoolean: Effect.sync(() => nextDoubleUnsafe() > 0.5),
    randomInt: Effect.sync(() => nextIntUnsafe()),
    randomBetween: (min, max) => Effect.sync(() => nextBetween(min, max, nextDoubleUnsafe())),
    randomIntBetween(min, max, options) {
      const extra = options?.halfOpen === true ? 0 : 1;
      return Effect.sync(() => {
        const minInt = Math.ceil(min);
        const maxInt = Math.floor(max);
        return Math.floor(nextDoubleUnsafe() * (maxInt - minInt + extra)) + minInt;
      });
    },
    randomShuffle: (elements) =>
      Effect.sync(() => {
        const buffer = Array.from(elements);
        for (let i = buffer.length - 1; i >= 1; i = i - 1) {
          const index = Math.min(i, Math.floor(nextDoubleUnsafe() * (i + 1)));
          const value = buffer[i];
          buffer[i] = buffer[index];
          buffer[index] = value;
        }
        return buffer;
      }),
    randomUUIDv4: ((options?: { readonly format?: "hex" | "bytes" | undefined }) =>
      Effect.sync(() => {
        const bytes = v4Bytes(randomBytesUnsafe(16));
        return options?.format === "bytes" ? bytes : uuidStringify(bytes);
      })) as unknown as Crypto["randomUUIDv4"],
    randomUUIDv7: ((options?: { readonly format?: "hex" | "bytes" | undefined }) =>
      Effect.clockWith((clock) => {
        const bytes = v7Bytes(clock.currentTimeMillisUnsafe(), randomBytesUnsafe(16));
        return Effect.succeed(options?.format === "bytes" ? bytes : uuidStringify(bytes));
      })) as unknown as Crypto["randomUUIDv7"],
    randomULID: Effect.clockWith((clock) =>
      Effect.succeed(ulidString(clock.currentTimeMillisUnsafe(), randomBytesUnsafe(10))),
    ),
  });
};

const validateSize = (method: string, size: number) =>
  Number.isSafeInteger(size) && size >= 0
    ? Effect.succeed(size)
    : Effect.fail(
        PlatformError.badArgument({
          module: "Crypto",
          method,
          description: "size must be a non-negative safe integer",
        }),
      );

/** The service implemented on the host's WebCrypto (`globalThis.crypto`). */
export const layerWebCrypto: Layer.Layer<Crypto> = Layer.succeed(
  Crypto,
  make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      const chunk = 65536;
      for (let offset = 0; offset < size; offset += chunk) {
        globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + chunk));
      }
      return bytes;
    },
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data.slice())),
        catch: (cause) =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
            description: `WebCrypto digest failed: ${cause}`,
          }),
      }),
  }),
);
