import { describe, expect, test } from "bun:test"
import { avgScore, avgScoreByTask } from "../../src/jit-optimize/loop.ts"
import type { Evidence, EvidenceCriterion } from "../../src/jit-optimize/types.ts"

function crit(score: number, opts: { infraError?: string } = {}): EvidenceCriterion {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    method: "llm-judge",
    weight: 1,
    score,
    passed: score >= 0.5,
    ...(opts.infraError ? { infraError: opts.infraError } : {}),
  }
}

function ev(taskId: string, score: number | "tainted"): Evidence {
  return {
    taskId,
    taskPrompt: `prompt-${taskId}`,
    conversationLog: [],
    workDirSnapshot: { files: new Map() },
    criteria: [score === "tainted" ? crit(0, { infraError: "test-taint" }) : crit(score)],
  }
}

describe("avgScore (task-grouped)", () => {
  test("single task, single run", () => {
    expect(avgScore([ev("A", 0.8)])).toBeCloseTo(0.8, 6)
  })

  test("uniform runs: matches flat mean", () => {
    // 2 tasks × 2 runs each, all clean. Flat mean and task-grouped mean
    // produce the same number when run counts are even across tasks.
    const evs = [
      ev("A", 1.0),
      ev("A", 1.0),
      ev("B", 0.0),
      ev("B", 0.0),
    ]
    expect(avgScore(evs)).toBeCloseTo(0.5, 6)
  })

  test("skewed runs: does NOT match flat mean (task-grouped is correct)", () => {
    // Task A has 3 runs (all 1.0), task B has 1 run (0.0).
    // Flat mean: (1 + 1 + 1 + 0) / 4 = 0.75 — weights A 3x.
    // Task-grouped: mean of {A_mean=1.0, B_mean=0.0} = 0.5.
    // Task-grouped is what we want.
    const evs = [
      ev("A", 1.0),
      ev("A", 1.0),
      ev("A", 1.0),
      ev("B", 0.0),
    ]
    expect(avgScore(evs)).toBeCloseTo(0.5, 6)
  })

  test("partial infra-taint in one task: surviving runs still represent the task", () => {
    // Task A: one clean run (1.0), one tainted run. Task B: two clean
    // runs averaging to 0.25. Task A's mean collapses to its single
    // clean run (1.0). Final: (1.0 + 0.25) / 2 = 0.625.
    const evs = [
      ev("A", 1.0),
      ev("A", "tainted"),
      ev("B", 0.5),
      ev("B", 0.0),
    ]
    expect(avgScore(evs)).toBeCloseTo(0.625, 6)
  })

  test("fully-tainted task is excluded from denominator", () => {
    // Task A's runs are all tainted. Task B is clean at 0.4. Result is
    // 0.4, not 0.2 — task A does not contribute a zero to the average.
    const evs = [
      ev("A", "tainted"),
      ev("A", "tainted"),
      ev("B", 0.4),
    ]
    expect(avgScore(evs)).toBeCloseTo(0.4, 6)
  })

  test("all tasks fully tainted: returns null", () => {
    const evs = [ev("A", "tainted"), ev("B", "tainted")]
    expect(avgScore(evs)).toBeNull()
  })

  test("empty evidence list: returns null", () => {
    expect(avgScore([])).toBeNull()
  })

  test("criteria-less evidence (score null from scoreFromCriteria) is skipped", () => {
    // An evidence with an empty criteria list scores null and does not
    // participate. Paired with a clean task, the clean task's mean
    // survives alone.
    const bad: Evidence = {
      taskId: "bad",
      taskPrompt: "",
      conversationLog: [],
      workDirSnapshot: { files: new Map() },
      criteria: [],
    }
    expect(avgScore([bad, ev("A", 0.7)])).toBeCloseTo(0.7, 6)
  })
})

describe("avgScoreByTask", () => {
  test("returns per-task means keyed by taskId", () => {
    const evs = [
      ev("A", 1.0),
      ev("A", 0.0),
      ev("B", 0.5),
    ]
    const result = avgScoreByTask(evs)
    expect(result).toEqual({ A: 0.5, B: 0.5 })
  })

  test("fully-tainted task is omitted", () => {
    const evs = [
      ev("A", "tainted"),
      ev("A", "tainted"),
      ev("B", 0.75),
    ]
    const result = avgScoreByTask(evs)
    expect(result).toEqual({ B: 0.75 })
  })

  test("partial taint: surviving runs form the mean", () => {
    const evs = [
      ev("A", 0.8),
      ev("A", "tainted"),
    ]
    expect(avgScoreByTask(evs)).toEqual({ A: 0.8 })
  })

  test("empty input: empty object", () => {
    expect(avgScoreByTask([])).toEqual({})
  })
})
