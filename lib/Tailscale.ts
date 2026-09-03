/**
 * Tailscale identity: who is behind a request.
 *
 * Two paths, by connection provenance:
 * - a tailnet peer (100.64/10) is identified by asking tailscaled
 *   (`tailscale whois`) about the socket address — WireGuard has already
 *   authenticated it; any Tailscale-* headers on such requests are ignored.
 * - a loopback peer is `tailscale serve` terminating TLS for the tailnet and
 *   injecting `Tailscale-User-Login` after verifying the peer itself. The
 *   header is trusted from loopback only: anything else on loopback is a
 *   process already inside the VM's trust boundary, and the exe.dev proxy
 *   authenticates the VM owner before a request reaches the port.
 */
import { execFile } from "node:child_process"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export class Tailscale extends Context.Service<Tailscale, {
  /** Login name (e.g. user@gmail.com) behind a request, or null. */
  readonly identify: (
    remoteAddress: string | null,
    headers: Readonly<Record<string, string | undefined>>
  ) => Effect.Effect<string | null>
}>()("medina/Tailscale") {}

/** Strip the port from a socket address without mangling bare IPv6:
 * only a bracketed host or a single-colon `ipv4:port` loses its port —
 * `::1` and `::ffff:127.0.0.1` pass through untouched (a bare IPv6 always
 * has at least two colons; a port suffix only follows a dotted quad). */
const stripPort = (address: string) => {
  if (address.startsWith("[")) {
    const end = address.indexOf("]")
    return end === -1 ? address : address.slice(1, end)
  }
  return (address.match(/:/g) ?? []).length === 1 ? address.slice(0, address.lastIndexOf(":")) : address
}

const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1"

const isTailnet = (ip: string) => {
  if (ip.startsWith("fd7a:115c:a1e0")) return true // Tailscale IPv6 range
  const match = ip.replace(/^::ffff:/, "").match(/^100\.(\d+)\./)
  return match !== null && Number(match[1]) >= 64 && Number(match[1]) <= 127 // CGNAT 100.64/10
}

const whois = (ip: string) =>
  Effect.callback<string | null>((resume) => {
    execFile("tailscale", ["whois", "--json", ip], { timeout: 3000 }, (error, stdout) => {
      if (error) return resume(Effect.succeed(null))
      try {
        const parsed = JSON.parse(stdout)
        resume(Effect.succeed(parsed?.UserProfile?.LoginName ?? null))
      } catch {
        resume(Effect.succeed(null))
      }
    })
  })

export const layer: Layer.Layer<Tailscale> = Layer.succeed(Tailscale)({
  identify: (remoteAddress, headers) => {
    if (!remoteAddress) return Effect.succeed(null)
    const ip = stripPort(remoteAddress)
    if (isTailnet(ip)) return whois(ip)
    if (isLoopback(ip)) return Effect.succeed(headers["tailscale-user-login"] ?? null)
    return Effect.succeed(null)
  }
})
