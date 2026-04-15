import "../../src/core/env-bootstrap.ts"
import { afterAll } from "bun:test"
import { readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { LOGS_DIR, PROFILES_DIR } from "../../src/core/config.ts"

const START_MS = Date.now()

afterAll(() => {
  sweepTestSessions(LOGS_DIR, START_MS)
  sweepTestModels(PROFILES_DIR)
  sweepNewFiles(path.join(LOGS_DIR, "runs"), START_MS)
})

function sweepTestSessions(dir: string, thresholdMs: number): void {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory() && st.ctimeMs >= thresholdMs) {
      rmSync(full, { recursive: true, force: true })
    }
  }
}

function sweepTestModels(dir: string): void {
  let harnesses: string[] = []
  try { harnesses = readdirSync(dir) } catch { return }
  for (const harness of harnesses) {
    let models: string[] = []
    try { models = readdirSync(path.join(dir, harness)) } catch { continue }
    for (const model of models) {
      if (model.startsWith("test--")) {
        rmSync(path.join(dir, harness, model), { recursive: true, force: true })
      }
    }
  }
}

function sweepNewFiles(dir: string, thresholdMs: number): void {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isFile() && st.ctimeMs >= thresholdMs) {
      rmSync(full, { force: true })
    }
  }
}
