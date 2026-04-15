import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EvalCriterion, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import { evaluate } from "../../src/framework/evaluator.ts"

export async function makeWorkDir(suffix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `skvm-eval-gt-${suffix}-`))
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export function baseResult(workDir: string): RunResult {
  return {
    text: "",
    steps: [],
    tokens: emptyTokenUsage(),
    cost: 0,
    durationMs: 0,
    llmDurationMs: 0,
    workDir,
    runStatus: "ok",
  }
}

export async function writeSetupFiles(
  dir: string,
  files: Record<string, string> | undefined,
): Promise<void> {
  if (!files) return
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }
}

/**
 * Run an eval criterion in the given workDir via the framework evaluator and
 * normalize into the `{ pass, stdout, stderr, exitCode }` shape used by the
 * reason and tool-follow ground-truth test suites.
 */
export async function runEval(
  criterion: EvalCriterion,
  dir: string,
): Promise<{ pass: boolean; stdout: string; stderr: string; exitCode: number }> {
  const result = await evaluate(criterion, baseResult(dir))
  return {
    pass: result.pass,
    stdout: result.details,
    stderr: "",
    exitCode: result.pass ? 0 : 1,
  }
}
