import { test, expect, describe } from "bun:test"
import {
  isInfraTaintedEvidence,
  avgScore,
  scoreFromCriteria,
  assertRoundNotAllInfraTainted,
} from "../../src/jit-optimize/loop.ts"
import type { Evidence, EvidenceCriterion } from "../../src/jit-optimize/types.ts"

function makeEvidence(criteria: EvidenceCriterion[], extra: Partial<Evidence> = {}): Evidence {
  return {
    taskId: "test-task",
    taskPrompt: "test",
    conversationLog: [],
    workDirSnapshot: { files: new Map() },
    criteria,
    ...extra,
  }
}

function crit(opts: {
  score: number
  passed: boolean
  weight?: number
  infraError?: string
}): EvidenceCriterion {
  return {
    id: `c-${Math.random()}`,
    method: "llm-judge",
    weight: opts.weight ?? 1,
    score: opts.score,
    passed: opts.passed,
    ...(opts.infraError ? { infraError: opts.infraError } : {}),
  }
}

describe("isInfraTaintedEvidence", () => {
  test("false when no criteria have infraError", () => {
    const ev = makeEvidence([
      crit({ score: 1, passed: true }),
      crit({ score: 0, passed: false }),
    ])
    expect(isInfraTaintedEvidence(ev)).toBe(false)
  })

  test("true when any criterion has infraError", () => {
    const ev = makeEvidence([
      crit({ score: 1, passed: true }),
      crit({ score: 0, passed: false, infraError: "provider down" }),
    ])
    expect(isInfraTaintedEvidence(ev)).toBe(true)
  })

  test("false for missing criteria", () => {
    const ev = makeEvidence([], { criteria: undefined })
    expect(isInfraTaintedEvidence(ev)).toBe(false)
  })
})

describe("scoreFromCriteria reweights around infraError", () => {
  test("excludes infra-tainted criteria and renormalizes weights", () => {
    // Two criteria with weight 0.5 each. One is a clean 1.0, the other is
    // infra-tainted. The result should be 1.0 (the clean one absorbs all
    // the weight) — not 0.5 (which would average in a zero).
    const score = scoreFromCriteria([
      crit({ score: 1.0, passed: true, weight: 0.5 }),
      crit({ score: 0.0, passed: false, weight: 0.5, infraError: "429" }),
    ])
    expect(score).toBe(1.0)
  })

  test("null when every criterion is infra-tainted", () => {
    const score = scoreFromCriteria([
      crit({ score: 0, passed: false, weight: 0.5, infraError: "a" }),
      crit({ score: 0, passed: false, weight: 0.5, infraError: "b" }),
    ])
    expect(score).toBeNull()
  })

  test("weighted avg with only non-infra criteria", () => {
    const score = scoreFromCriteria([
      crit({ score: 1.0, passed: true, weight: 0.75 }),
      crit({ score: 0.0, passed: false, weight: 0.25 }),
    ])
    expect(score).toBe(0.75)
  })
})

describe("avgScore filters tainted evidences", () => {
  test("tainted evidences are excluded from the numerator and denominator", () => {
    // Three runs: two clean (scored 1.0 and 0.0), one tainted. Average
    // should be 0.5 (1+0)/2, NOT 0.333 (1+0+0)/3.
    const evidences: Evidence[] = [
      makeEvidence([crit({ score: 1.0, passed: true })]),
      makeEvidence([crit({ score: 0.0, passed: false })]),
      makeEvidence([crit({ score: 0.0, passed: false, infraError: "timeout" })]),
    ]
    expect(avgScore(evidences)).toBe(0.5)
  })

  test("null when every evidence is tainted", () => {
    const evidences: Evidence[] = [
      makeEvidence([crit({ score: 0, passed: false, infraError: "a" })]),
      makeEvidence([crit({ score: 0, passed: false, infraError: "b" })]),
    ]
    expect(avgScore(evidences)).toBeNull()
  })

  test("empty round returns null", () => {
    expect(avgScore([])).toBeNull()
  })
})

describe("assertRoundNotAllInfraTainted", () => {
  test("passes when at least one evidence is clean", () => {
    const clean = makeEvidence([crit({ score: 0.5, passed: false })])
    const tainted = makeEvidence([crit({ score: 0, passed: false, infraError: "x" })])
    expect(() => assertRoundNotAllInfraTainted("round-1", [clean], [tainted])).not.toThrow()
  })

  test("throws with descriptive message when every evidence is tainted", () => {
    const t1 = makeEvidence([crit({ score: 0, passed: false, infraError: "401 auth failed" })])
    const t2 = makeEvidence([crit({ score: 0, passed: false, infraError: "429 rate limit" })])
    expect(() => assertRoundNotAllInfraTainted("round-2", [t1], [t2])).toThrow(/round-2/)
    expect(() => assertRoundNotAllInfraTainted("round-2", [t1], [t2])).toThrow(/401 auth failed/)
  })

  test("empty round does not throw (nothing to judge)", () => {
    expect(() => assertRoundNotAllInfraTainted("round-0", [], [])).not.toThrow()
  })
})
