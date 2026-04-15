import { describe, test, expect } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { customEvaluators } from "../../src/framework/types.ts"
// Side-effect import to guarantee python-grade is registered. In production
// code the barrel (`src/bench/evaluators/index.ts`) is imported by loaders;
// tests import it directly so they exercise the same path.
import "../../src/bench/evaluators/index.ts"
import type { EvalCriterion, RunResult } from "../../src/core/types.ts"

const baseRunResult = (workDir: string): RunResult => ({
  text: "", steps: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0, durationMs: 0, llmDurationMs: 0, workDir,
  runStatus: "ok",
})

function criterionWith(payload: string): Extract<EvalCriterion, { method: "custom" }> {
  return {
    method: "custom",
    evaluatorId: "python-grade",
    id: "custom",
    name: "Automated Grade",
    weight: 1.0,
    payload,
  }
}

describe("python-grade evaluator (new CustomEvaluator contract)", () => {
  test("is registered at module load", () => {
    expect(customEvaluators.has("python-grade")).toBe(true)
  })

  test("evaluates a simple grade function returning a record list", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_eval-"))
    await Bun.write(path.join(workDir, "hello.txt"), "Hello, World!")

    const payload = `
def grade(transcript, workspace_path):
    from pathlib import Path
    workspace = Path(workspace_path)
    file_ok = (workspace / "hello.txt").exists()
    return [
        {
            "id": "file-created",
            "score": 1.0 if file_ok else 0.0,
            "weight": 1.0,
            "description": "hello.txt exists in the workspace root",
        },
    ]
`
    const result = await evaluator.run({
      criterion: criterionWith(payload),
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBe(1.0)
    expect(result.pass).toBe(true)
    expect(result.checkpoints?.length).toBe(1)
    expect(result.checkpoints?.[0]?.weight).toBe(1.0)
    expect(result.checkpoints?.[0]?.description).toBe("hello.txt exists in the workspace root")

    await rm(workDir, { recursive: true, force: true })
  })

  test("computes weighted average across multiple records", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_weighted-"))

    const payload = `
def grade(transcript, workspace_path):
    return [
        {"id": "major", "score": 1.0, "weight": 0.75, "description": "Heavy check"},
        {"id": "minor", "score": 0.0, "weight": 0.25, "description": "Light check", "details": "not implemented"},
    ]
`
    const result = await evaluator.run({
      criterion: criterionWith(payload),
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBeCloseTo(0.75, 6)
    expect(result.pass).toBe(true)
    expect(result.checkpoints?.length).toBe(2)
    const minor = result.checkpoints?.find((c) => c.name === "minor")
    expect(minor?.reason).toBe("not implemented")

    await rm(workDir, { recursive: true, force: true })
  })

  test("rejects grade functions whose weights do not sum to 1", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_badweight-"))

    const payload = `
def grade(transcript, workspace_path):
    return [
        {"id": "a", "score": 1.0, "weight": 0.4},
        {"id": "b", "score": 1.0, "weight": 0.4},
    ]
`
    const result = await evaluator.run({
      criterion: criterionWith(payload),
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBe(0.0)
    expect(result.details.toLowerCase()).toContain("weights must sum to 1")

    await rm(workDir, { recursive: true, force: true })
  })

  test("rejects duplicate criterion ids", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_dup-"))

    const payload = `
def grade(transcript, workspace_path):
    return [
        {"id": "same", "score": 1.0, "weight": 0.5},
        {"id": "same", "score": 1.0, "weight": 0.5},
    ]
`
    const result = await evaluator.run({
      criterion: criterionWith(payload),
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBe(0.0)
    expect(result.details.toLowerCase()).toContain("duplicate")

    await rm(workDir, { recursive: true, force: true })
  })

  test("handles all-zero scores with valid weights", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_zero-"))

    const payload = `
def grade(transcript, workspace_path):
    return [
        {"id": "check1", "score": 0.0, "weight": 0.5, "description": "first"},
        {"id": "check2", "score": 0.0, "weight": 0.5, "description": "second"},
    ]
`
    const result = await evaluator.run({
      criterion: criterionWith(payload),
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBe(0.0)
    expect(result.pass).toBe(false)

    await rm(workDir, { recursive: true, force: true })
  })

  test("rejects criterion with missing payload", async () => {
    const evaluator = customEvaluators.get("python-grade")!
    const workDir = await mkdtemp(path.join(tmpdir(), "test_nopayload-"))

    const result = await evaluator.run({
      criterion: {
        method: "custom",
        evaluatorId: "python-grade",
        // no payload
      },
      runResult: baseRunResult(workDir),
    })
    expect(result.score).toBe(0.0)
    expect(result.details).toContain("payload")

    await rm(workDir, { recursive: true, force: true })
  })
})
