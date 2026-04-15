#!/usr/bin/env node
// Node shim that execs the real skvm binary fetched by install/postinstall.js.
// Works for both the `npm i -g @ipads-skvm/skvm` path and the local dev path:
//   - installed: bin/skvm (compiled Bun binary) sits next to this shim
//   - dev:       no binary present, fall back to `bun run <repo>/src/index.ts`
// npm's bin symlink points at this .js file (package.json bin.skvm), while the
// native binary has no extension — the two filenames coexist without collision.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const binary = path.join(here, process.platform === "win32" ? "skvm.exe" : "skvm")

let cmd
let args

if (existsSync(binary)) {
  cmd = binary
  args = process.argv.slice(2)
} else {
  const repoRoot = path.resolve(here, "..")
  const entry = path.join(repoRoot, "src", "index.ts")
  if (!existsSync(entry)) {
    console.error(
      `skvm: binary not found at ${binary} and no src/index.ts next to this shim.\n` +
        `If you installed via npm, re-run \`npm i -g @ipads-skvm/skvm\` so postinstall can download the binary.\n` +
        `If you are a contributor running from source, run \`bun run src/index.ts\` directly.`,
    )
    process.exit(1)
  }
  cmd = "bun"
  args = ["run", entry, ...process.argv.slice(2)]
}

const result = spawnSync(cmd, args, { stdio: "inherit" })
if (result.error) {
  console.error(`skvm: failed to spawn ${cmd}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
