# Optional Tailscale auth

Medina can run behind any HTTPS reverse proxy. Tailscale Serve is a convenient optional choice for private deployments because it can provide identity headers in addition to TLS.

A typical private deployment binds Medina to localhost:

```env
HOST=127.0.0.1
PORT=3002
MEDINA_ROOT=https://your-machine.your-tailnet.ts.net/
```

Then exposes it through Tailscale Serve:

```bash
tailscale serve --https=443 127.0.0.1:3002
```

If a stream user includes a credential of type `tailscale`, requests carrying the matching `Tailscale-User-Login` header are accepted.

```ts
credentials: [
  { type: "tailscale", value: "alice@example.com" },
]
```

Token credentials remain the default portable auth path. Keep the backend bound to `127.0.0.1` if you rely on proxy-provided identity headers.
