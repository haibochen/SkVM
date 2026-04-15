import { describe, expect, test } from "bun:test"
import {
  pickBestRound,
  DEFAULT_MIN_IMPROVEMENT,
} from "../../src/jit-optimize/loop.ts"
import type { RoundResult } from "../../src/jit-optimize/types.ts"

/**
 * Layer 1 of the pickBestRound hardening:
 *  - baseline gate (MIN_IMPROVEMENT noise floor)
 *  - epsilon-aware tie resolution
 *  - convergence short-circuit
 *  - improved-flag alignment (checked here via the selection reason string)
 *
 * Uses testScore as the primary (hasTest: true) unless a test explicitly
 * wants train-only semantics. Keeps fixture construction terse so individual
 * cases are readable.
 */

function r(
  round: number,
  primary: number | null,
  opts: Partial<{
    isBaseline: boolean
    tokens: number
    durationMs: number
    costUsd: number
    trainScore: number | null
    perTaskTestScores: Record<string, number>
    perTaskTrainScores: Record<string, number>
  }> = {},
): RoundResult {
  return {
    round,
    isBaseline: opts.isBaseline ?? round === 0,
    trainScore: opts.trainScore ?? primary,
    testScore: primary,
    trainPassed: 0,
    trainTotal: 0,
    testPassed: 0,
    testTotal: 0,
    perTaskTrainScores: opts.perTaskTrainScores ?? opts.perTaskTestScores ?? {},
    perTaskTestScores: opts.perTaskTestScores ?? opts.perTaskTrainScores ?? {},
    targetAgent: {
      tokens: { input: opts.tokens ?? 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: opts.costUsd ?? 0,
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

const OPTS = {
  hasTest: true as const,
  trainScoresComparable: true as const,
  convergenceThreshold: 0.95,
  minImprovement: DEFAULT_MIN_IMPROVEMENT,
}

describe("Layer 1 — MIN_IMPROVEMENT noise floor", () => {
  test("round 1 at 0.81 vs baseline at 0.80 is inside the floor → baseline", () => {
    const result = pickBestRound([r(0, 0.80), r(1, 0.81)], OPTS)
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("noise floor")
  })

  test("round 1 at 0.85 vs baseline at 0.80 exceeds the floor → round 1", () => {
    const result = pickBestRound([r(0, 0.80), r(1, 0.85)], OPTS)
    expect(result.bestRound).toBe(1)
    expect(result.reason).toContain("+0.050")
  })

  test("clearly above boundary: baseline 0.80 + improvement 0.021 wins", () => {
    // Floating-point reminder: `0.80 + 0.02` as IEEE-754 doubles is
    // 0.8200000000000001 and `0.82` literal is ~0.81999…, so the exact
    // boundary is not meaningful. The engine intentionally uses `>=`
    // and leaves boundary cases fuzzy; practical thresholds should be
    // clearly above or below the floor.
    const result = pickBestRound([r(0, 0.80), r(1, 0.821)], OPTS)
    expect(result.bestRound).toBe(1)
  })

  test("round 1 below baseline is dropped (obvious regression)", () => {
    const result = pickBestRound([r(0, 0.80), r(1, 0.50)], OPTS)
    expect(result.bestRound).toBe(0)
  })

  test("obsidian-style regression: train=0.95 vs baseline=0.82 clears floor but real holdout gate is elsewhere", () => {
    // This test captures Layer 1's contract: when train-as-test overstates
    // improvement, Layer 1 alone cannot catch it. The safety lives in
    // Layer 2 (per-task monotonicity) or the explicit --test-tasks split.
    // Here we simply assert Layer 1 promotes the round that looks good,
    // because on these inputs it genuinely clears the floor.
    const result = pickBestRound([r(0, 0.82), r(1, 0.95)], OPTS)
    expect(result.bestRound).toBe(1)
  })
})

describe("Layer 1 — epsilon tie resolution", () => {
  test("equivalence-band tie between two non-baseline rounds defers to cost then round number", () => {
    // Both beat baseline by enough, but their primary difference (0.001)
    // is below the score equivalence band (0.02). Cost is zero on both, so
    // the cost tiebreak is skipped and round-number ascending wins.
    const result = pickBestRound(
      [r(0, 0.50), r(2, 0.851), r(3, 0.850)],
      OPTS,
    )
    expect(result.bestRound).toBe(2)
  })

  test("epsilon tie with baseline: baseline is in the pool only when gate passes", () => {
    // Baseline is always a survivor. If a non-baseline round is within
    // epsilon of baseline, the noise floor already dropped it — so the
    // epsilon band is NEVER the path through which a non-baseline round
    // could tie with baseline.
    const result = pickBestRound([r(0, 0.80), r(1, 0.8001)], OPTS)
    expect(result.bestRound).toBe(0)
  })

  test("clearly-distinct primaries are not ties — higher one wins above the equivalence band", () => {
    // The equivalence band defaults to DEFAULT_MIN_IMPROVEMENT (0.02), so
    // a delta just above it must promote the higher round. Deltas within
    // 0.02 now intentionally tie and defer to cost/round-number tiebreaks
    // — that widening is the whole point of Layer 3.
    const delta = DEFAULT_MIN_IMPROVEMENT + 0.001
    const result = pickBestRound(
      [r(0, 0.50), r(1, 0.80), r(2, 0.80 + delta)],
      OPTS,
    )
    expect(result.bestRound).toBe(2)
  })
})

describe("Layer 1 — convergence short-circuit", () => {
  test("baseline at convergence threshold → round 0 wins regardless of later rounds", () => {
    const result = pickBestRound(
      [r(0, 0.96), r(1, 0.99)],
      { ...OPTS, convergenceThreshold: 0.95 },
    )
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("convergence threshold")
  })

  test("baseline just below threshold does NOT short-circuit", () => {
    const result = pickBestRound(
      [r(0, 0.94), r(1, 0.98)],
      { ...OPTS, convergenceThreshold: 0.95 },
    )
    expect(result.bestRound).toBe(1)
  })

  test("baseline at exactly threshold triggers the short-circuit", () => {
    const result = pickBestRound(
      [r(0, 0.95), r(1, 0.99)],
      { ...OPTS, convergenceThreshold: 0.95 },
    )
    expect(result.bestRound).toBe(0)
  })
})

describe("Layer 1 — mixed nulls and filter interactions", () => {
  test("mixed nulls: [0.80, null, 0.85, 0.83] → round 2 wins (null filtered, 3 within epsilon of 2)", () => {
    const result = pickBestRound(
      [r(0, 0.80), r(1, null), r(2, 0.85), r(3, 0.83)],
      OPTS,
    )
    // 0.85 and 0.83 both beat floor (0.82). |0.85 - 0.83| = 0.02, above
    // epsilon, so round 2 wins outright.
    expect(result.bestRound).toBe(2)
  })

  test("no scored rounds → returns 0 with diagnostic reason", () => {
    const result = pickBestRound([r(0, null), r(1, null)], OPTS)
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("no rounds had evaluatable scores")
  })

  test("baseline absent from input: degenerate path still returns something sane", () => {
    // Defensive: in practice round 0 is always synthesized, but if a
    // caller ever passes only non-baseline rounds, the highest primary
    // should win with an explicit "no baseline reference" reason.
    const result = pickBestRound(
      [r(1, 0.60, { isBaseline: false }), r(2, 0.80, { isBaseline: false })],
      OPTS,
    )
    expect(result.bestRound).toBe(2)
    expect(result.reason).toContain("no baseline reference")
  })
})

describe("Layer 2 — per-task monotonicity gate", () => {
  // Task-distribution fixtures: mean is the same but a specific task
  // collapsed. The aggregate primary is irrelevant to this gate — what
  // matters is the per-task intersection with round 0.

  test("mirror-flip: round N mean equals round 0 but one task regressed by 0.5 → excluded", () => {
    // round 0 {A: 1.0, B: 0.5} mean 0.75
    // round 1 {A: 0.5, B: 1.0} mean 0.75 — same mean, task A collapsed.
    // Baseline wins, round 1 goes into excludedRounds.
    const result = pickBestRound(
      [
        r(0, 0.75, { perTaskTestScores: { A: 1.0, B: 0.5 } }),
        r(1, 0.80, { perTaskTestScores: { A: 0.5, B: 1.0 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.excludedRounds[1]).toContain("task 'A'")
    expect(result.excludedRounds[1]).toContain("drop=0.500")
  })

  test("partial regression: mean improved but B fell by 0.2 (at tolerance boundary) → NOT excluded", () => {
    // A drop of exactly the tolerance is permitted (the check is strict >).
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 0.55, { perTaskTestScores: { A: 0.8, B: 0.3 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.excludedRounds[1]).toBeUndefined()
  })

  test("partial regression: B fell by 0.3 → excluded even though aggregate improved", () => {
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 0.60, { perTaskTestScores: { A: 0.9, B: 0.2 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.excludedRounds[1]).toContain("task 'B'")
  })

  test("clean improvement: A up, B stable → wins outright, nothing excluded", () => {
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 0.675, { perTaskTestScores: { A: 0.8, B: 0.55 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.excludedRounds).toEqual({})
  })

  test("new task in round N not in round 0 (synthetic regen) → intersection skipped, no false exclusion", () => {
    // Round 1 has task C that round 0 didn't see. C is ignored by the
    // gate; the check runs only on A (common). A's drop is 0.05, well
    // under the 0.2 tolerance, so round 1 is allowed through.
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.50 } }),
        r(1, 0.70, { perTaskTestScores: { A: 0.45, C: 0.95 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.excludedRounds).toEqual({})
  })

  test("all rounds excluded → returns baseline with 'per-task regression' reason", () => {
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 0.60, { perTaskTestScores: { A: 0.9, B: 0.1 } }),
        r(2, 0.60, { perTaskTestScores: { A: 0.1, B: 0.9 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("all improving rounds regressed")
    expect(Object.keys(result.excludedRounds)).toHaveLength(2)
  })

  test("custom tolerance: wider tolerance lets a bigger regression through", () => {
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 0.60, { perTaskTestScores: { A: 0.9, B: 0.1 } }),
      ],
      { ...OPTS, perTaskRegressionTolerance: 0.5 },
    )
    expect(result.bestRound).toBe(1)
  })

  test("no per-task data on baseline (degenerate round) → gate is a no-op", () => {
    // When round 0 has an empty perTaskTestScores (e.g. legacy proposal,
    // never-evaluated round), the gate cannot compare and skips entirely.
    // Layer 1 still does its work.
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: {} }),
        r(1, 0.70, { perTaskTestScores: { A: 0.9, B: 0.1 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.excludedRounds).toEqual({})
  })

  test("candidate is missing a baseline task entirely → excluded (Codex review P1)", () => {
    // A task that exists in round 0 but has no clean runs in the
    // candidate round (all runs infra-tainted, or the evidence array
    // missing it) must be treated as a regression, not silently
    // skipped. Iterating the candidate's keys would let
    // baseline {A:0.5, B:0.5} vs candidate {B:1.0} win, because A
    // never shows up in the comparison loop. The gate must iterate
    // the BASELINE task set to catch this.
    const result = pickBestRound(
      [
        r(0, 0.50, { perTaskTestScores: { A: 0.5, B: 0.5 } }),
        r(1, 1.00, { perTaskTestScores: { B: 1.0 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.excludedRounds[1]).toContain("task 'A'")
    expect(result.excludedRounds[1]).toContain("no clean runs")
  })

  test("candidate missing multiple baseline tasks → excluded on first one encountered", () => {
    const result = pickBestRound(
      [
        r(0, 0.60, { perTaskTestScores: { A: 0.6, B: 0.6, C: 0.6 } }),
        r(1, 0.80, { perTaskTestScores: { B: 0.8 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.excludedRounds[1]).toMatch(/task '(A|C)'/)
    expect(result.excludedRounds[1]).toContain("no clean runs")
  })
})

describe("Layer 1 — historical regression replay", () => {
  // The three proposals that motivated this fix. All used real-task source
  // with testIsSeparate=false, so the engine fed trainScore as the primary
  // to pickBestRound. Under the old logic these promoted the higher round;
  // under Layer 1 they must all fall back to baseline.

  test("obsidian / deepseek-v3.2: baseline 0.82, round 2 0.95 (clears floor)", () => {
    // This case the old engine picked — and bench said the pick was wrong.
    // Layer 1 alone still picks round 2 because the train-only primary
    // genuinely clears the floor. Protection for this class of failure
    // lives in Layer 2 (per-task monotonicity) and the --test-tasks
    // complementary enforcement.
    const result = pickBestRound(
      [r(0, 0.82), r(1, 0.88), r(2, 0.95)],
      OPTS,
    )
    expect(result.bestRound).toBe(2)
  })

  test("chart-generator / deepseek-v3.2: baseline 0.81, round 1 0.94 (clears floor by 0.13)", () => {
    const result = pickBestRound([r(0, 0.81), r(1, 0.94)], OPTS)
    expect(result.bestRound).toBe(1)
  })

  test("nano-pdf / deepseek-v3.2: baseline 0.80, round 0 wins if round 1 is null (abstain/infra)", () => {
    // Layer 1 can catch this one because the abstain path leaves round 1
    // with null scores, which hit the null filter.
    const result = pickBestRound([r(0, 0.80), r(1, null)], OPTS)
    expect(result.bestRound).toBe(0)
  })

  test("noise-floor case: round 1 only 0.015 above baseline is dropped", () => {
    // Classic noise case: looks like improvement, is within empirical std
    // on low-evidence sessions.
    const result = pickBestRound([r(0, 0.80), r(1, 0.815)], OPTS)
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("noise floor")
  })
})

describe("Layer 3 — cost-aware selection", () => {
  // Cost is only meaningful when the adapter actually reports it. All
  // fixtures in this block set `costUsd` explicitly on both baseline and
  // candidate so `costComparisonEnabled` is true. Layer-2 per-task gates
  // still fire first — cost is never license to ship a regression.

  test("score-tied cost win: same primary, cheaper round wins and reason mentions cost", () => {
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.80, { costUsd: 0.80 })],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.reason).toContain("cost")
    expect(result.reason).toContain("ties baseline")
  })

  test("sub-threshold score + cost win: +0.01 score but 40% cheaper → admitted by branch (b)", () => {
    // Score improvement 0.01 is below the 0.02 noise floor, so branch (a)
    // of the baseline gate rejects it. But cost cut is 40% (>> 15%
    // threshold), and score is within the equivalence band of baseline,
    // so branch (b) admits it.
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.81, { costUsd: 0.60 })],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.reason).toContain("cost")
  })

  test("sub-threshold score without meaningful cost cut → dropped", () => {
    // Score improvement 0.01 (below floor) AND cost cut only 5% (below
    // 15% threshold). Neither branch of the gate admits. Baseline wins.
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.81, { costUsd: 0.95 })],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("noise floor")
  })

  test("cost win vetoed by per-task regression: Layer 2 runs AFTER cost admission", () => {
    // Round 1 has same primary and half the cost, so the baseline gate
    // admits it via branch (b). But its per-task distribution regresses
    // task A from 1.0 to 0.5. The monotonicity gate excludes it — cost
    // is never license to ship a per-task collapse.
    const result = pickBestRound(
      [
        r(0, 0.75, { costUsd: 1.0, perTaskTestScores: { A: 1.0, B: 0.5 } }),
        r(1, 0.75, { costUsd: 0.50, perTaskTestScores: { A: 0.5, B: 1.0 } }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.excludedRounds[1]).toContain("task 'A'")
  })

  test("zero-cost adapter: comparison disabled, falls back to pure score-only logic", () => {
    // Jiuwenclaw-style $0 reporting. Score tie → noise floor rejects
    // round 1 because branch (b) is disabled when baseline cost is zero.
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 0 }), r(1, 0.80, { costUsd: 0 })],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
  })

  test("baseline cost zero but candidate reports cost: still disabled (no baseline ratio)", () => {
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 0 }), r(1, 0.80, { costUsd: 0.50 })],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
  })

  test("score win AND cost drop: reason surfaces both gates with AND clause", () => {
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.90, { costUsd: 0.50 })],
      OPTS,
    )
    expect(result.bestRound).toBe(1)
    expect(result.reason).toContain("+0.100")
    expect(result.reason).toContain("AND cuts")
  })

  test("custom minCostReductionRatio: looser threshold lets 12% cut win", () => {
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.80, { costUsd: 0.88 })],
      { ...OPTS, minCostReductionRatio: 0.10 },
    )
    expect(result.bestRound).toBe(1)
  })

  test("cost tiebreak within equivalence band when both rounds clear the score floor", () => {
    // Baseline 0.50, round 1 at 0.80 ($1.50), round 2 at 0.81 ($0.90).
    // Both non-baseline rounds clear the noise floor by a wide margin.
    // Within-band tiebreak on score (|0.81-0.80| < 0.02) hands victory
    // to the cheaper round — round 2.
    const result = pickBestRound(
      [
        r(0, 0.50, { costUsd: 2.0 }),
        r(1, 0.80, { costUsd: 1.5 }),
        r(2, 0.81, { costUsd: 0.90 }),
      ],
      OPTS,
    )
    expect(result.bestRound).toBe(2)
  })

  test("no-round-beats-baseline reason includes cost clause when cost comparison enabled", () => {
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.81, { costUsd: 0.98 })],
      OPTS,
    )
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("nor cut target-agent cost")
    expect(result.reason).toContain("15%")
  })

  test("synthetic regen: trainScoresComparable=false disables cost-based admission", () => {
    // sumTargetAgentStats merges train+test evidences into one costUsd
    // bucket. When the synthetic-task source regenerates the train probe
    // mid-session, round N's cost mixes a different train batch with the
    // frozen test, so delta vs round 0 no longer represents optimizer
    // work. Mirrors the existing trainScore guard: the whole cost axis
    // must drop out, not just the score tiebreak.
    const result = pickBestRound(
      [r(0, 0.80, { costUsd: 1.0 }), r(1, 0.80, { costUsd: 0.50 })],
      { ...OPTS, trainScoresComparable: false },
    )
    expect(result.bestRound).toBe(0)
    expect(result.reason).toContain("noise floor")
    expect(result.reason).not.toContain("nor cut target-agent cost")
  })

  test("synthetic regen: cost is not a sort tiebreak when trainScoresComparable=false", () => {
    // Both round 1 and round 2 clear the noise floor vs baseline 0.50,
    // and |0.81 - 0.80| < scoreEquivalenceBand (0.02) so scores tie. With
    // cost comparison disabled, the comparator falls through to the
    // round-number tiebreak — round 1 (earlier) wins, NOT round 2
    // despite being cheaper.
    const result = pickBestRound(
      [
        r(0, 0.50, { costUsd: 2.0 }),
        r(1, 0.80, { costUsd: 1.5 }),
        r(2, 0.81, { costUsd: 0.90 }),
      ],
      { ...OPTS, trainScoresComparable: false },
    )
    expect(result.bestRound).toBe(1)
  })
})
