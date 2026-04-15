import { describe, expect, test } from "bun:test"
import { OptimizeSubmissionSchema } from "../../src/jit-optimize/types.ts"
import { normalizeSubmission } from "../../src/jit-optimize/optimizer.ts"

// These tests exercise the schema + normalizer indirectly through
// OptimizeSubmissionSchema.parse(). `normalizeSubmission` is an internal
// helper inside optimizer.ts and isn't exported, but it's a pure function
// of the schema'd raw shape, so the schema's parse behavior is what
// downstream callers observe.

describe("OptimizeSubmissionSchema — infraBlocked shape", () => {
  test("accepts a well-formed infraBlocked submission", () => {
    const raw = {
      infraBlocked: true,
      blockedEvidenceIds: ["0", "1"],
      blockedReason: "Evidence 0 and 1 both timed out with tokens=0",
    }
    const parsed = OptimizeSubmissionSchema.parse(raw)
    expect(parsed.infraBlocked).toBe(true)
    expect(parsed.blockedEvidenceIds).toEqual(["0", "1"])
    expect(parsed.blockedReason).toContain("timed out")
  })

  test("all infraBlocked fields are optional (backwards compat)", () => {
    // An edit-shape submission must still parse — no infraBlocked fields.
    const parsed = OptimizeSubmissionSchema.parse({
      rootCause: "skill lacks X",
      reasoning: "agent tried Y",
      confidence: 0.8,
      changedFiles: ["SKILL.md"],
      changes: [{ file: "SKILL.md", description: "add X", generality: "any Y task" }],
    })
    expect(parsed.infraBlocked).toBeUndefined()
    expect(parsed.blockedEvidenceIds).toBeUndefined()
  })

  test("accepts infraBlocked=true with empty blockedEvidenceIds (engine warns, does not reject)", () => {
    const parsed = OptimizeSubmissionSchema.parse({
      infraBlocked: true,
      blockedEvidenceIds: [],
      blockedReason: "not sure which one",
    })
    expect(parsed.infraBlocked).toBe(true)
    expect(parsed.blockedEvidenceIds).toEqual([])
  })

  test("rejects non-string evidence ids", () => {
    const r = OptimizeSubmissionSchema.safeParse({
      infraBlocked: true,
      blockedEvidenceIds: [0, 1] as unknown as string[],
      blockedReason: "x",
    })
    expect(r.success).toBe(false)
  })
})

describe("normalizeSubmission", () => {
  test("infraBlocked=true yields an empty-edits canonical form", () => {
    const n = normalizeSubmission({
      infraBlocked: true,
      blockedEvidenceIds: ["0", "1"],
      blockedReason: "timeout x2",
    })
    expect(n.infraBlocked).toBe(true)
    expect(n.noChanges).toBe(false)
    expect(n.changes).toEqual([])
    expect(n.changedFiles).toEqual([])
    expect(n.blockedEvidenceIds).toEqual(["0", "1"])
    expect(n.blockedReason).toBe("timeout x2")
  })

  test("infraBlocked wins over noChanges when both set", () => {
    // Negative statement about evidence quality beats positive statement
    // about skill quality. Engine logs a warning but trusts infraBlocked.
    const n = normalizeSubmission({
      infraBlocked: true,
      noChanges: true,
      blockedEvidenceIds: ["0"],
      blockedReason: "timeout",
    })
    expect(n.infraBlocked).toBe(true)
    expect(n.noChanges).toBe(false)
  })

  test("missing blocked fields default to empty", () => {
    const n = normalizeSubmission({ infraBlocked: true })
    expect(n.infraBlocked).toBe(true)
    expect(n.blockedEvidenceIds).toEqual([])
    expect(n.blockedReason).toBe("")
  })

  test("noChanges path unchanged by this feature", () => {
    const n = normalizeSubmission({ noChanges: true })
    expect(n.noChanges).toBe(true)
    expect(n.infraBlocked).toBeUndefined()
    expect(n.changes).toEqual([])
  })

  test("edit path unchanged by this feature", () => {
    const n = normalizeSubmission({
      rootCause: "x",
      reasoning: "y",
      confidence: 0.7,
      changedFiles: ["SKILL.md"],
      changes: [{ file: "SKILL.md", description: "d", generality: "g" }],
    })
    expect(n.noChanges).toBe(false)
    expect(n.infraBlocked).toBeUndefined()
    expect(n.changedFiles).toEqual(["SKILL.md"])
  })
})
