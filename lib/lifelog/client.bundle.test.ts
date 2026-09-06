/**
 * The client bundle must stay loadable as a classic script.
 *
 * `Pages.tsx` serves it with a plain `<script src defer>`, not
 * `type="module"`. A classic script cannot even *parse* `import.meta`, so a
 * single occurrence anywhere in the bundle is a SyntaxError before the first
 * statement runs: no console error the server can see, no RPC request, and a
 * page stuck on "Loading…" forever.
 *
 * This is easy to reintroduce, because the trigger is indirect. Modules the
 * browser shares with the server (`Resources.ts` defines both sides' artifact
 * schemas) must not reach anything that pulls in `effect/Config`, which reads
 * `import.meta.env`. That is why `ArtifactKey.ts` exists apart from
 * `ArtifactStore.ts`.
 */
import { describe, expect, it } from "bun:test"

const build = async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./client.ts", import.meta.url).pathname],
    target: "browser",
    minify: true
  })
  if (!result.success) throw new AggregateError(result.logs, "client bundle failed to build")
  return await result.outputs[0].text()
}

describe("client bundle", () => {
  it("parses as a classic script: no import.meta", async () => {
    const code = await build()
    const hits = code.match(/import\.meta/g) ?? []
    expect(hits).toEqual([])
  })

  it("has no bare ESM import/export left to trip a classic script", async () => {
    const code = await build()
    expect(code).not.toMatch(/(^|[;}\s])export\s*\{/)
  })
})
