// Ensure `<repoRoot>/.env` is loaded into process.env at process startup,
// regardless of the shell's cwd. Bun's built-in `.env` auto-load only fires
// for the cwd at startup, which breaks entry points like the compiled binary,
// `bun test` launched from a subdirectory, `bun /abs/path/src/index.ts`, and
// IDE test runners. Every internal read of OPENROUTER_API_KEY / ANTHROPIC_API_KEY
// goes through `process.env`, and every spawned subprocess (hermes, opencode,
// jit-optimize headless agent, framework evaluators, jiuwenclaw sidecar env
// writer) inherits the parent env — so fixing the top-level process here is
// sufficient to propagate credentials down the entire call chain.
//
// Existing variables are never overwritten, so shell exports and CI-injected
// secrets keep precedence over the repo .env.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")

function loadEnvFile(filePath: string): void {
  let text: string
  try {
    text = readFileSync(filePath, "utf8")
  } catch {
    return
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key] !== undefined) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadEnvFile(path.join(REPO_ROOT, ".env"))
