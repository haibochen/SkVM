import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TestResult } from "./types.ts"
import { LOGS_DIR } from "../core/config.ts"

/**
 * Save test results to a JSON file.
 */
export async function saveResults(results: TestResult[], sessionId?: string): Promise<string> {
  const id = sessionId ?? `run-${Date.now()}`
  const dir = path.join(LOGS_DIR, "runs")
  await mkdir(dir, { recursive: true })

  const outPath = path.join(dir, `${id}.json`)

  const summary = results.map((r) => ({
    taskId: r.task.id,
    pass: r.overallPass,
    score: r.overallScore,
    durationMs: r.runResult.durationMs,
    tokens: r.runResult.tokens,
    cost: r.runResult.cost,
    evalDetails: r.evalResults.map((e) => ({
      method: e.criterion.method,
      pass: e.pass,
      score: e.score,
      details: e.details,
    })),
    timestamp: r.timestamp,
  }))

  await writeFile(outPath, JSON.stringify(summary, null, 2))
  return outPath
}

/**
 * Print a concise summary to stdout.
 */
export function printSummary(results: TestResult[]): void {
  const total = results.length
  const passed = results.filter((r) => r.overallPass).length
  const avgScore = total > 0
    ? results.reduce((sum, r) => sum + r.overallScore, 0) / total
    : 0

  console.log(`\n--- Results: ${passed}/${total} passed (avg score: ${avgScore.toFixed(2)}) ---`)

  for (const r of results) {
    const status = r.overallPass ? "PASS" : "FAIL"
    const score = r.overallScore.toFixed(2)
    const duration = (r.runResult.durationMs / 1000).toFixed(1)
    console.log(`  ${status} ${r.task.id} (score=${score}, ${duration}s)`)

    for (const e of r.evalResults) {
      if (!e.pass) {
        console.log(`    FAIL [${e.criterion.method}]: ${e.details.slice(0, 100)}`)
      }
    }
  }
}
