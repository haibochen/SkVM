import { test, expect, describe } from "bun:test"
import { PRIMITIVES, getPrimitive, ALL_PRIMITIVE_IDS } from "../../src/core/primitives.ts"

describe("Primitives catalog", () => {
  // Uniqueness is load-bearing: profiler caches are keyed by primitive ID, and
  // a duplicate would silently corrupt profile lookups.
  test("all IDs are unique", () => {
    const ids = new Set(ALL_PRIMITIVE_IDS)
    expect(ids.size).toBe(ALL_PRIMITIVE_IDS.length)
  })

  test("getPrimitive resolves known IDs and rejects unknown", () => {
    const p = getPrimitive("gen.code.python")
    expect(p).toBeDefined()
    expect(p!.category).toBe("generation")
    expect(getPrimitive("nonexistent")).toBeUndefined()
  })

  test("every primitive has non-empty level descriptions", () => {
    for (const p of PRIMITIVES) {
      expect(p.levels.L1.length).toBeGreaterThan(0)
      expect(p.levels.L2.length).toBeGreaterThan(0)
      expect(p.levels.L3.length).toBeGreaterThan(0)
    }
  })
})
