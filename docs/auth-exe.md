# exe.dev proxy auth

Medina accepts exe.dev's authenticated proxy identity as an alternative to a Medina token. Configure a stream user with an `email` credential matching the `X-ExeDev-Email` header injected by exe.dev:

```ts
credentials: [
  { type: "email", value: "alice@example.com" },
]
```

For an exe.dev private proxy, authenticated requests include this header automatically. For a public proxy, users must first sign in through exe.dev before the header is present. Medina rejects an unrecognized exe.dev email with `403` and falls back to token auth when no exe.dev identity is sent.

Keep Medina bound to `127.0.0.1` when relying on proxy-provided identity headers, so clients cannot forge them by connecting directly to the backend.
