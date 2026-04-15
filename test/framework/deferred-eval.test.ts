import { test, expect, describe } from "bun:test"
import { mergeDeferredResults, type MergeableConditionResult } from "../../src/framework/deferred-eval.ts"
import type { DeferredJudgeResult } from "../../src/framework/deferred-eval.ts"
import type { EvalDetail } from "../../src/bench/types.ts"

function makeCR(overrides: Partial<MergeableConditionResult> = {}): MergeableConditionResult {
  return {
    condition: "original",
    score: 0.7,
    pass: true,
    evalDetails: [],
    ...overrides,
  }
}

function makeJudgeResult(taskId: string, condition: string, criterionId: string | undefined, score: number, criterionIndex = 0): DeferredJudgeResult {
  return {
    id: `${taskId}-${condition}-${criterionIndex}`,
    context: { sessionId: "s", taskId, condition, criterionIndex, criterionId },
    pass: score >= 0.5,
    score,
    details: "judge reasoning",
    criterion: { method: "llm-judge", rubric: "r", maxScore: 1.0 },
    evaluatedAt: new Date().toISOString(),
  }
}

describe("mergeDeferredResults", () => {
  test("sync ↔ async parity: per-criterion weighted recompute", () => {
    // Simulated sync result where the llm-judge slot is still zeroed (deferred).
    const details: EvalDetail[] = [
      { id: "custom-0", method: "custom", score: 1.0, weight: 0.7, details: "python-grade pass" },
      { id: "llm-judge-1", method: "llm-judge", score: 0, weight: 0.3, details: "LLM judge deferred" },
    ]
    const cr = makeCR({ score: 0.7, pass: true, evalDetails: details })
    const map = new Map<string, MergeableConditionResult[]>([["task-a", [cr]]])

    const judgeResult = makeJudgeResult("task-a", "original", "llm-judge-1", 0.6)
    mergeDeferredResults([judgeResult], map)

    // 0.7 * 1.0 + 0.3 * 0.6 = 0.88
    expect(cr.score).toBeCloseTo(0.88, 6)
    expect(cr.pass).toBe(true)
    expect(cr.evalDetails[1]!.score).toBe(0.6)
    expect(cr.evalDetails[1]!.details).toBe("judge reasoning")
    // automated/llm-judge breakdown must also be populated
    expect(cr.automatedScore).toBeCloseTo(1.0, 6)
    expect(cr.llmJudgeScore).toBeCloseTo(0.6, 6)
  })

  test("merges by criterion id regardless of evalDetails order", () => {
    const details: EvalDetail[] = [
      { id: "llm-judge-1", method: "llm-judge", score: 0, weight: 0.4, details: "deferred" },
      { id: "custom-0", method: "custom", score: 0.5, weight: 0.6, details: "pass" },
    ]
    const cr = makeCR({ evalDetails: details })
    const map = new Map<string, MergeableConditionResult[]>([["t", [cr]]])

    // criterionIndex=0 would be the WRONG slot (custom-0 is at index 1).
    // The merge must use criterionId, not the index.
    const judgeResult = makeJudgeResult("t", "original", "llm-judge-1", 1.0, 0)
    mergeDeferredResults([judgeResult], map)

    expect(cr.evalDetails[0]!.score).toBe(1.0)
    expect(cr.evalDetails[1]!.score).toBe(0.5)
    // 0.4 * 1.0 + 0.6 * 0.5 = 0.7
    expect(cr.score).toBeCloseTo(0.7, 6)
  })

  test("missing criterion id is a no-op, not a crash", () => {
    const details: EvalDetail[] = [
      { id: "custom-0", method: "custom", score: 1.0, weight: 0.5, details: "" },
      { id: "llm-judge-1", method: "llm-judge", score: 0, weight: 0.5, details: "" },
    ]
    const cr = makeCR({ evalDetails: details })
    const map = new Map<string, MergeableConditionResult[]>([["t", [cr]]])

    const judgeResult = makeJudgeResult("t", "original", "nonexistent-id", 0.5)
    const snapshot = JSON.parse(JSON.stringify(cr))
    mergeDeferredResults([judgeResult], map)

    expect(cr.evalDetails).toEqual(snapshot.evalDetails)
  })

  test("positional fallback when criterionId is absent", () => {
    const details: EvalDetail[] = [
      { method: "custom", score: 1.0, weight: 0.5, details: "" },
      { method: "llm-judge", score: 0, weight: 0.5, details: "deferred" },
    ]
    const cr = makeCR({ evalDetails: details })
    const map = new Map<string, MergeableConditionResult[]>([["t", [cr]]])

    const judgeResult = makeJudgeResult("t", "original", undefined, 0.8, 1)
    mergeDeferredResults([judgeResult], map)

    expect(cr.evalDetails[1]!.score).toBe(0.8)
    // 0.5 * 1.0 + 0.5 * 0.8 = 0.9
    expect(cr.score).toBeCloseTo(0.9, 6)
  })

  test("legacy gradingWeights path", () => {
    const details: EvalDetail[] = [
      { id: "script-0", method: "script", score: 1.0, details: "" },
      { id: "judge-0", method: "llm-judge", score: 0, details: "deferred" },
    ]
    const cr = makeCR({
      evalDetails: details,
      gradingWeights: { automated: 0.6, llmJudge: 0.4 },
    })
    const map = new Map<string, MergeableConditionResult[]>([["t", [cr]]])

    mergeDeferredResults([makeJudgeResult("t", "original", "judge-0", 0.5)], map)
    // 0.6 * 1.0 + 0.4 * 0.5 = 0.8
    expect(cr.score).toBeCloseTo(0.8, 6)
  })
})
