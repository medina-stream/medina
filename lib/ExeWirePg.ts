/**
 * Postgres over an exe.dev wire integration (e.g. `supabase-medina`).
 *
 * The VM holds no database secret: TCP is tunneled to the integration host
 * with an HTTP CONNECT through the local exe proxy, upgraded to TLS (the
 * edge presents its own certificate), and the edge injects the upstream
 * credential during the Postgres handshake. The local proxy endpoint comes
 * from `HTTPS_PROXY` and its port changes per boot, so it is read at dial
 * time, never cached at import.
 */
import * as Effect from "effect/Effect"
import * as PgClient from "@effect/sql-pg/PgClient"
import { Duplex } from "node:stream"
import * as net from "node:net"
import * as tls from "node:tls"

export interface ExeWirePgOptions {
  readonly host: string
  readonly port?: number | undefined
  readonly database?: string | undefined
  readonly maxConnections?: number | undefined
}

const proxyEndpoint = () => {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? ""
  const url = new URL(raw)
  return { host: url.hostname, port: Number(url.port) }
}

const readUntil = (socket: net.Socket, delim: string) =>
  Effect.callback<Buffer, Error>((resume) => {
    let settled = false
    const done = (result: Effect.Effect<Buffer, Error>) => {
      if (settled) return
      settled = true
      socket.off("data", onData)
      resume(result)
    }
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.includes(delim)) done(Effect.succeed(buf))
    }
    socket.on("data", onData)
    socket.on("error", (cause) => done(Effect.fail(cause)))
  })

const readBytes = (stream: Duplex, n: number) =>
  Effect.callback<Buffer, Error>((resume) => {
    let settled = false
    const done = (result: Effect.Effect<Buffer, Error>) => {
      if (settled) return
      settled = true
      stream.off("data", onData)
      resume(result)
    }
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) done(Effect.succeed(buf.subarray(0, n)))
    }
    stream.on("data", onData)
    stream.on("error", (cause) => done(Effect.fail(cause)))
  })

/** CONNECT tunnel + Postgres SSLRequest + TLS. Resolves to the secure stream. */
const dialSecure = (host: string, port: number): Effect.Effect<Duplex, Error> =>
  Effect.gen(function*() {
    const proxy = proxyEndpoint()
    const raw = yield* Effect.callback<net.Socket, Error>((resume) => {
      let settled = false
      const done = (result: Effect.Effect<net.Socket, Error>) => {
        if (settled) return
        settled = true
        resume(result)
      }
      const socket = net.connect(proxy.port, proxy.host)
      socket.on("connect", () => done(Effect.succeed(socket)))
      socket.on("error", (cause) => done(Effect.fail(cause)))
    })
    raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    const head = yield* readUntil(raw, "\r\n\r\n")
    const status = head.toString("latin1").split("\r\n")[0] ?? ""
    if (!/^HTTP\/\d(\.\d)? 2\d\d/.test(status)) {
      return yield* Effect.fail(new Error(`wire proxy refused ${host}:${port}: ${status}`))
    }
    const req = Buffer.alloc(8)
    req.writeInt32BE(8, 0)
    req.writeInt32BE(80877103, 4)
    raw.write(req)
    const flag = yield* readBytes(raw as unknown as Duplex, 1)
    if (flag[0] !== 0x53) {
      return yield* Effect.fail(new Error(`wire host ${host}:${port} refused TLS upgrade`))
    }
    return yield* Effect.callback<Duplex, Error>((resume) => {
      let settled = false
      const done = (result: Effect.Effect<Duplex, Error>) => {
        if (settled) return
        settled = true
        resume(result)
      }
      const secure = tls.connect({ socket: raw, servername: host })
      secure.on("secureConnect", () => done(Effect.succeed(secure as unknown as Duplex)))
      secure.on("error", (cause) => done(Effect.fail(cause)))
    })
  })

/**
 * A pg-compatible stream that dials the wire integration when pg connects.
 * Writes before the tunnel is ready are buffered; each pooled connection
 * dials its own tunnel.
 */
export const makeWireStream = (host: string, port: number): Duplex => {
  let target: Duplex | null = null
  const pending: Array<{ chunk: Buffer; cb: () => void }> = []
  const stream = new Duplex({
    write(chunk, _encoding, cb) {
      if (target) {
        target.write(chunk, cb as never)
      } else {
        pending.push({ chunk: Buffer.from(chunk), cb: cb as () => void })
      }
    },
    read() {},
    destroy(err, cb) {
      target?.destroy()
      cb(err)
    }
  })
  const api = stream as unknown as Record<string, unknown>
  api["setNoDelay"] = () => api
  api["setKeepAlive"] = () => api
  api["setTimeout"] = () => api
  api["ref"] = () => api
  api["unref"] = () => undefined
  api["connect"] = () => {
    Effect.runFork(
      dialSecure(host, port).pipe(
        Effect.tap((secure) =>
          Effect.sync(() => {
            target = secure
            secure.on("data", (chunk: Buffer) => {
              stream.push(chunk)
            })
            secure.on("error", (cause) => stream.destroy(cause as Error))
            secure.on("close", () => stream.push(null))
            for (const w of pending.splice(0)) target?.write(w.chunk, w.cb as never)
            stream.emit("connect")
          })
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            stream.destroy((cause as unknown as { toString(): string }).toString() as never)
          })
        )
      )
    )
    return api
  }
  return stream
}

/** `SqlClient` over the wire integration. No password: the edge injects it. */
export const layer = (options: ExeWirePgOptions) =>
  PgClient.layer({
    database: options.database ?? "postgres",
    ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
    stream: () => makeWireStream(options.host, options.port ?? 5432)
  })
