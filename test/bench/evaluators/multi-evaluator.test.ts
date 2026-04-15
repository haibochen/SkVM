/**
 * Regression guard for the custom-evaluator extensibility pattern.
 *
 * Scenario: a hypothetical "mock-grader" evaluator is registered alongside
 * python-grade. This test verifies that:
 *   1. Multiple custom evaluators can coexist in `customEvaluators`.
 *   2. `hydrateEvalPayloads` dispatches to each evaluator's own
 *      `loadPayload` by `evaluatorId`, not by position or insertion order.
 *   3. `evaluateCustom` routes to the right evaluator and preserves the
 *      upstream criterion (id, name, weight, payload).
 *
 * This test exists so that a future contributor adding a new evaluator
 * under `src/bench/evaluators/<new>.ts` has a worked example of the pattern
 * and a regression tripwire if the dispatch mechanism breaks.
 */

import { describe, test, expect, beforeAll } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  customEvaluators,
  registerCustomEvaluator,
  type CustomEvaluator,
} from "../../../src/framework/types.ts"
import { hydrateEvalPayloads } from "../../../src/bench/evaluators/index.ts"
import { evaluate } from "../../../src/framework/evaluator.ts"
import type { EvalCriterion, RunResult } from "../../../src/core/types.ts"

// Mock evaluator: reads a sibling "mock-config.json" at load time, passes
// iff payload.shouldPass is true.
interface MockPayload {
  shouldPass: boolean
  label: string
}

const mockGrader: CustomEvaluator = {
  async run({ criterion }) {
    const p = criterion.payload as MockPayload | undefined
    if (!p) {
      return { pass: false, score: 0, details: "mock-grader: missing payload" }
    }
    return {
      pass: p.shouldPass,
      score: p.shouldPass ? 1 : 0,
      details: `mock-grader[${p.label}]: ${p.shouldPass ? "pass" : "fail"}`,
    }
  },
  async loadPayload(taskDir: string) {
    const f = Bun.file(path.join(taskDir, "mock-config.json"))
    if (!(await f.exists())) return undefined
    return JSON.parse(await f.text())
  },
}

beforeAll(() => {
  registerCustomEvaluator("mock-grader", mockGrader)
})

const baseRunResult = (workDir: string): RunResult => ({
  text: "", steps: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0, durationMs: 0, llmDurationMs: 0, workDir,
  runStatus: "ok",
})

describe("multi-evaluator registry", () => {
  test("python-grade and mock-grader coexist in the registry", () => {
    expect(customEvaluators.has("python-grade")).toBe(true)
    expect(customEvaluators.has("mock-grader")).toBe(true)
    expect(customEvaluators.size).toBeGreaterThanOrEqual(2)
  })

  test("hydrateEvalPayloads dispatches to each evaluator by evaluatorId", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "multi-eval-hydrate-"))
    await mkdir(taskDir, { recursive: true })
    await Bun.write(
      path.join(taskDir, "mock-config.json"),
      JSON.stringify({ shouldPass: true, label: "hydrated" }),
    )
    await Bun.write(
      path.join(taskDir, "grade.py"),
      "def grade(t, w): return [{'id':'c','score':1.0,'weight':1.0}]",
    )

    const criteria: EvalCriterion[] = [
      { method: "custom", evaluatorId: "python-grade" },
      { method: "custom", evaluatorId: "mock-grader" },
    ]
    await hydrateEvalPayloads(criteria, taskDir)

    // python-grade got its sibling grade.py as a string
    expect(criteria[0]!.method).toBe("custom")
    if (criteria[0]!.method === "custom") {
      expect(typeof criteria[0]!.payload).toBe("string")
      expect(criteria[0]!.payload as string).toContain("def grade")
    }
    // mock-grader got its sibling mock-config.json as a parsed object
    if (criteria[1]!.method === "custom") {
      expect(criteria[1]!.payload).toEqual({ shouldPass: true, label: "hydrated" })
    }

    await rm(taskDir, { recursive: true, force: true })
  })

  test("evaluateCustom routes to the correct evaluator", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "multi-eval-run-"))

    const passResult = await evaluate(
      {
        method: "custom",
        evaluatorId: "mock-grader",
        id: "mock-1",
        name: "Mock Check",
        weight: 0.5,
        payload: { shouldPass: true, label: "unit" },
      },
      { ...baseRunResult(workDir) },
    )
    expect(passResult.pass).toBe(true)
    expect(passResult.score).toBe(1)
    expect(passResult.details).toContain("mock-grader[unit]: pass")
    // Framework re-attached the caller's full criterion
    expect(passResult.criterion.id).toBe("mock-1")
    expect(passResult.criterion.name).toBe("Mock Check")
    expect(passResult.criterion.weight).toBe(0.5)

    const failResult = await evaluate(
      {
        method: "custom",
        evaluatorId: "mock-grader",
        payload: { shouldPass: false, label: "unit" },
      },
      { ...baseRunResult(workDir) },
    )
    expect(failResult.pass).toBe(false)
    expect(failResult.score).toBe(0)

    await rm(workDir, { recursive: true, force: true })
  })
})
