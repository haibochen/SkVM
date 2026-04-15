import { describe, expect, test } from "bun:test"
import {
  InfraBlockedRoundError,
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

function crit(opts: { score: number; passed: boolean; weight?: number; infraError?: string }): EvidenceCriterion {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    method: "llm-judge",
    weight: opts.weight ?? 1,
    score: opts.score,
    passed: opts.passed,
    ...(opts.infraError ? { infraError: opts.infraError } : {}),
  }
}

describe("InfraBlockedRoundError", () => {
  test("captures roundLabel, reason, blockedIds, and partialEvidence", () => {
    const ev = makeEvidence([crit({ score: 0, passed: false, infraError: "x" })])
    const err = new InfraBlockedRoundError("round-2", "timeout x2", ["0", "1"], [ev])
    expect(err.name).toBe("InfraBlockedRoundError")
    expect(err.roundLabel).toBe("round-2")
    expect(err.reason).toBe("timeout x2")
    expect(err.blockedIds).toEqual(["0", "1"])
    expect(err.partialEvidence).toEqual([ev])
    expect(err.message).toContain("round-2")
    expect(err.message).toContain("timeout x2")
  })

  test("is instanceof Error for catch compatibility", () => {
    const err = new InfraBlockedRoundError("round-0", "any", [], [])
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(InfraBlockedRoundError)
  })

  test("assertRoundNotAllInfraTainted populates partialEvidence so callers can preserve target-agent cost (Codex review P2)", () => {
    // When every evidence in a round is infra-tainted, the catch sites
    // in runLoop need access to the tainted evidences to sum their
    // already-paid target-agent tokens via sumTargetAgentStats. Pre-fix,
    // the error discarded the array and callers zeroed cost.
    const tainted1 = makeEvidence([crit({ score: 0, passed: false, infraError: "timeout" })])
    const tainted2 = makeEvidence([crit({ score: 0, passed: false, infraError: "timeout" })])
    let caught: InfraBlockedRoundError | undefined
    try {
      assertRoundNotAllInfraTainted("round-1", [tainted1, tainted2], [])
    } catch (e) {
      if (e instanceof InfraBlockedRoundError) caught = e
    }
    expect(caught).toBeDefined()
    expect(caught!.partialEvidence).toHaveLength(2)
    expect(caught!.partialEvidence[0]).toBe(tainted1)
    expect(caught!.partialEvidence[1]).toBe(tainted2)
  })
})

describe("assertRoundNotAllInfraTainted — round 0 / round N all-tainted path", () => {
  test("throws InfraBlockedRoundError when every evidence is tainted", () => {
    const tainted = [
      makeEvidence([crit({ score: 0, passed: false, infraError: "401 auth failed" })]),
      makeEvidence([crit({ score: 0, passed: false, infraError: "429 rate limit" })]),
    ]
    let caught: unknown = undefined
    try {
      assertRoundNotAllInfraTainted("round-1", tainted, [])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InfraBlockedRoundError)
    const err = caught as InfraBlockedRoundError
    expect(err.roundLabel).toBe("round-1")
    expect(err.reason).toContain("401 auth failed")
    // Both indices should be reported as blocked.
    expect(err.blockedIds).toEqual(["0", "1"])
  })

  test("does NOT throw when at least one evidence is clean", () => {
    const clean = makeEvidence([crit({ score: 0.5, passed: false })])
    const tainted = makeEvidence([crit({ score: 0, passed: false, infraError: "timeout" })])
    expect(() => assertRoundNotAllInfraTainted("round-1", [clean], [tainted])).not.toThrow()
  })

  test("empty round does not throw (nothing to judge)", () => {
    expect(() => assertRoundNotAllInfraTainted("round-0", [], [])).not.toThrow()
  })

  test("train all-tainted + test all-tainted → blockedIds covers distinct evidences in order", () => {
    const t1 = makeEvidence([crit({ score: 0, passed: false, infraError: "a" })])
    const t2 = makeEvidence([crit({ score: 0, passed: false, infraError: "b" })])
    const u1 = makeEvidence([crit({ score: 0, passed: false, infraError: "c" })])
    let caught: InfraBlockedRoundError | undefined
    try {
      assertRoundNotAllInfraTainted("round-3", [t1, t2], [u1])
    } catch (e) {
      if (e instanceof InfraBlockedRoundError) caught = e
    }
    expect(caught).toBeDefined()
    expect(caught!.blockedIds).toEqual(["0", "1", "2"])
  })

  test("same array passed as train and test (testIsSeparate=false) → ids are not doubled", () => {
    // In the common shared-train-as-test mode, runBoth calls
    // assertRoundNotAllInfraTainted(roundLabel, trainEv, trainEv). The
    // resulting blockedEvidenceIds must enumerate DISTINCT evidences, not
    // positions in the concatenated list — otherwise the meta/history
    // audit points to nonexistent evidence-N.md files.
    const e1 = makeEvidence([crit({ score: 0, passed: false, infraError: "timeout" })])
    const e2 = makeEvidence([crit({ score: 0, passed: false, infraError: "timeout" })])
    const shared = [e1, e2]
    let caught: InfraBlockedRoundError | undefined
    try {
      assertRoundNotAllInfraTainted("round-1", shared, shared)
    } catch (e) {
      if (e instanceof InfraBlockedRoundError) caught = e
    }
    expect(caught).toBeDefined()
    expect(caught!.blockedIds).toEqual(["0", "1"])
  })
})
