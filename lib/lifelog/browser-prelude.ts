/**
 * Browser prelude. Must be the FIRST import of the client entry: modules
 * shared with the server (e.g. `Resources.ts`) read Node globals at import
 * time, which do not exist in browsers. The client never calls the code
 * paths that need them, so inert stubs suffice.
 */
(globalThis as Record<string, unknown>).process ??= { env: {}, cwd: () => "/" }
