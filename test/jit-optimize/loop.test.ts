import { describe, expect, test } from "bun:test"
import { pickBestRound } from "../../src/jit-optimize/loop.ts"
import type { RoundResult } from "../../src/jit-optimize/types.ts"

const DEFAULT_OPTS = {
  convergenceThreshold: 0.95,
  minImprovement: 0.02,
} as const

function pick(
  rounds: RoundResult[],
  opts: { hasTest: boolean; trainScoresComparable: boolean },
) {
  return pickBestRound(rounds, { ...DEFAULT_OPTS, ...opts })
}

function r(
  round: number,
  trainScore: number | null,
  opts: Partial<{ tokens: number; durationMs: number; testScore: number | null }> = {},
): RoundResult {
  return {
    round,
    isBaseline: round === 0,
    trainScore,
    testScore: opts.testScore ?? null,
    trainPassed: 0,
    trainTotal: 2,
    testPassed: 0,
    testTotal: 0,
    perTaskTrainScores: {},
    perTaskTestScores: {},
    targetAgent: {
      tokens: { input: opts.tokens ?? 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      runs: 1,
      durationMs: opts.durationMs ?? 1000,
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

describe("pickBestRound baseline gate", () => {
  test("tied-on-primary non-baseline is dropped by noise floor; baseline wins", () => {
    // Under the new logic, a non-baseline round that equals baseline on the
    // primary score is filtered at the noise floor regardless of tokens or
    // round number. Token/duration tiebreaks can no longer displace the
    // baseline on a floating-point tie — that was the old bug.
    const result = pick([r(0, 0.3), r(1, 0.3)], { hasTest: false, trainScoresComparable: true })
    expect(result.bestRound).toBe(0)
  })

  test("higher train score still wins outright when delta clears the floor", () => {
    const result = pick(
      [r(0, 0.637), r(1, 0.665), r(2, 0.779), r(3, 0.745)],
      { hasTest: false, trainScoresComparable: true },
    )
    expect(result.bestRound).toBe(2)
  })

  test("when later rounds collapse to 0, baseline wins", () => {
    const result = pick(
      [r(0, 0.191), r(1, 0.0), r(2, 0.0)],
      { hasTest: false, trainScoresComparable: true },
    )
    expect(result.bestRound).toBe(0)
  })

  test("non-baseline rounds below the noise floor are filtered even when they equal baseline on tokens", () => {
    // Old behavior: token tiebreak fires and round-1 wins on lower cost.
    // New behavior: round-1 primary (0.5) does not exceed baseline (0.5) by
    // >= minImprovement, so it is dropped before tiebreaks run. Baseline
    // wins. Token savings are not a reason to displace round-0.
    const result = pick(
      [r(0, 0.5, { tokens: 5000 }), r(1, 0.5, { tokens: 1000 })],
      { hasTest: false, trainScoresComparable: true },
    )
    expect(result.bestRound).toBe(0)
  })
})

describe("pickBestRound null-score filter (no-edit rounds)", () => {
  test("a null-score no-edit round cannot beat a scored round-0", () => {
    const result = pick([r(0, 0.5), r(1, null)], { hasTest: false, trainScoresComparable: true })
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("only baseline scored")
  })

  test("null-score round cannot compete with a regression either", () => {
    // Round-1 edited but regressed; round-2 is a no-edit attempt with no
    // comparable score. Round-0 should still win outright.
    const result = pick(
      [r(0, 0.5), r(1, 0.3), r(2, null)],
      { hasTest: false, trainScoresComparable: true },
    )
    expect(result.bestRound).toBe(0)
  })

  test("testIsSeparate=true: null testScore is filtered even if trainScore is set", () => {
    // With a separate test set, pickBestRound sorts by testScore and the
    // filter is `r.testScore !== null`. A round that records train but
    // null test (as the no-edit fix emits) must never win.
    const result = pick(
      [
        r(0, 0.865, { testScore: 0.825 }),
        r(1, null, { testScore: null }),
      ],
      { hasTest: true, trainScoresComparable: true },
    )
    expect(result.bestRound).toBe(0)
  })
})

describe("pickBestRound trainScoresComparable=false (post-regen)", () => {
  test("equal testScores are caught by the baseline gate, not the train tiebreak", () => {
    // Both rounds share testScore=0.6 → r2 fails the noise floor and is
    // dropped outright. Round-0 wins without needing the tiebreak chain.
    const result = pick(
      [
        r(0, 0.5, { testScore: 0.6 }),
        r(2, 0.8, { testScore: 0.6 }),
      ],
      { hasTest: true, trainScoresComparable: false },
    )
    expect(result.bestRound).toBe(0)
  })

  test("a cheaper round cannot displace baseline when scores tie", () => {
    // Old behavior: token tiebreak (1000 < 5000) picks r2. New behavior: r2
    // fails the baseline gate on testScore and is dropped. Token cost
    // cannot displace baseline on a noise-level win.
    const result = pick(
      [
        r(0, 0.5, { testScore: 0.6, tokens: 5000 }),
        r(2, 0.9, { testScore: 0.6, tokens: 1000 }),
      ],
      { hasTest: true, trainScoresComparable: false },
    )
    expect(result.bestRound).toBe(0)
  })

  test("real primary-score differences still decide the winner", () => {
    // When a non-baseline round genuinely clears the noise floor, primary
    // differences still win — the gate only filters at the edges.
    const result = pick(
      [
        r(0, 0.5, { testScore: 0.5 }),
        r(2, 0.9, { testScore: 0.7 }),
      ],
      { hasTest: true, trainScoresComparable: false },
    )
    expect(result.bestRound).toBe(2)
  })
})
