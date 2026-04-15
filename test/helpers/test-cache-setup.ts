import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

if (!process.env.SKVM_CACHE) {
  process.env.SKVM_CACHE = mkdtempSync(path.join(os.tmpdir(), "skvm-test-"))
}
