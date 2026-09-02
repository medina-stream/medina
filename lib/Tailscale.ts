/**
 * Tailscale identity: who owns the device behind a tailnet source address.
 * Wraps `tailscale whois`, which asks the local tailscaled — the WireGuard
 * layer has already authenticated the peer, so this is a lookup, not a
 * challenge.
 */
import { execFile } from "node:child_process"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export class Tailscale extends Context.Service<Tailscale, {
  /** Login name (e.g. user@gmail.com) for a tailnet IP, or null when the
   * address is not a tailnet peer (proxy traffic, localhost, ...). */
  readonly whois: (address: string) => Effect.Effect<string | null>
}>()("medina/Tailscale") {}

export const layer: Layer.Layer<Tailscale> = Layer.succeed(Tailscale)({
  whois: (address) =>
    Effect.callback<string | null>((resume) => {
      // strip port and IPv6 brackets; whois accepts bare IPs
      const ip = address.replace(/^\[?([^\]]+?)\]?(:\d+)?$/, "$1")
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
})
