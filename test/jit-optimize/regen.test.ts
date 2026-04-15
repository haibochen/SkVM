import { describe, expect, test } from "bun:test"
import {
  findLastScoredRound,
  shouldRegenerateSyntheticTrain,
} from "../../src/jit-optimize/loop.ts"
import type { RoundResult, TaskSource } from "../../src/jit-optimize/types.ts"

function baseRound(
  round: number,
  opts: { trainScore: number | null; testScore?: number | null } = { trainScore: null },
): RoundResult {
  return {
    round,
    isBaseline: round === 0,
    trainScore: opts.trainScore,
    testScore: opts.testScore ?? null,
    trainPassed: 0,
    trainTotal: 0,
    testPassed: 0,
    testTotal: 0,
    perTaskTrainScores: {},
    perTaskTestScores: {},
    targetAgent: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      runs: 0,
      durationMs: 0,
    },
    evalJudge: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      calls: 0,
    },
    optimizer: null,
    historyEntry: null,
  }
}

const syntheticSource: TaskSource = { kind: "synthetic-task", trainCount: 3, testCount: 2 }
const realSource: TaskSource = { kind: "real-task", trainTasks: ["skill:pdf:extract"] }

function result(opts: { changed: boolean; noChanges?: boolean }) {
  return {
    changed: opts.changed,
    submission: { noChanges: opts.noChanges },
  }
}

describe("shouldRegenerateSyntheticTrain", () => {
  test("synthetic + explicit noChanges + count=1 + testIsSeparate → regenerates", () => {
    const ok = shouldRegenerateSyntheticTrain(
      syntheticSource,
      result({ changed: false, noChanges: true }),
      1,
      true,
    )
    expect(ok).toBe(true)
  })

  test("real source + noChanges → false (wrong source)", () => {
    const ok = shouldRegenerateSyntheticTrain(
      realSource,
      result({ changed: false, noChanges: true }),
      1,
      true,
    )
    expect(ok).toBe(false)
  })

  test("synthetic + missing submission (noChanges undefined) → false", () => {
    // "Submission missing/malformed" path: optimizer.ts's emptySubmission
    // sets noChanges to false, not true. The regen heuristic only fires
    // on an explicit noChanges signal, so this must return false — those
    // rounds take the normal problem-1 termination path instead.
    const ok = shouldRegenerateSyntheticTrain(
      syntheticSource,
      result({ changed: false, noChanges: false }),
      1,
      true,
    )
    expect(ok).toBe(false)
  })

  test("synthetic + noChanges + count=2 → false (budget exhausted)", () => {
    // Cumulative budget is 2 no-edit rounds total. At count=2 (i.e. this
    // is the second no-edit round in the session), no further regen.
    const ok = shouldRegenerateSyntheticTrain(
      syntheticSource,
      result({ changed: false, noChanges: true }),
      2,
      true,
    )
    expect(ok).toBe(false)
  })

  test("synthetic + noChanges but optimizer actually edited → false (defensive)", () => {
    // If the optimizer contradicts itself (declared noChanges but also
    // edited files), we're on the edit path, not the no-edit path —
    // this helper shouldn't even be consulted, but return false just in
    // case.
    const ok = shouldRegenerateSyntheticTrain(
      syntheticSource,
      result({ changed: true, noChanges: true }),
      1,
      true,
    )
    expect(ok).toBe(false)
  })

  test("synthetic + noChanges but testIsSeparate=false → false (scores become incomparable)", () => {
    // When testCount=0, testIsSeparate is false. runBoth shares train
    // evidence as test evidence, and pickBestRound uses trainScore as
    // the cross-round metric. Regenerating currentTrainTasks mid-session
    // would mean round-0's trainScore and round-N's trainScore are
    // computed on different synthetic probes — they can no longer be
    // compared, so the regen heuristic cannot be applied in this mode.
    const ok = shouldRegenerateSyntheticTrain(
      syntheticSource,
      result({ changed: false, noChanges: true }),
      1,
      false,
    )
    expect(ok).toBe(false)
  })
})

describe("findLastScoredRound", () => {
  test("returns the most recent scored round, skipping null-scored placeholders", () => {
    // allRounds: [r0 scored, r1 scored, r2 null-scored (no-edit regen)]
    // When processing round 3, the edit-path comparison must use r1 as
    // the baseline, not r2. Otherwise `improved` stays null and the
    // anti-oscillation signal in history.md is lost.
    const rounds = [
      baseRound(0, { trainScore: 0.5 }),
      baseRound(1, { trainScore: 0.6 }),
      baseRound(2, { trainScore: null }),
    ]
    const found = findLastScoredRound(rounds, false)
    expect(found).toBeDefined()
    expect(found!.round).toBe(1)
  })

  test("uses testScore when hasTest=true", () => {
    const rounds = [
      baseRound(0, { trainScore: 0.5, testScore: 0.4 }),
      baseRound(1, { trainScore: 0.6, testScore: null }),
    ]
    // r1 has a non-null trainScore but null testScore; with hasTest=true
    // it should be skipped in favor of r0.
    const found = findLastScoredRound(rounds, true)
    expect(found).toBeDefined()
    expect(found!.round).toBe(0)
  })

  test("returns undefined when every round is null-scored", () => {
    const rounds = [
      baseRound(0, { trainScore: null }),
      baseRound(1, { trainScore: null }),
    ]
    const found = findLastScoredRound(rounds, false)
    expect(found).toBeUndefined()
  })

  test("empty list returns undefined", () => {
    expect(findLastScoredRound([], false)).toBeUndefined()
  })
})

