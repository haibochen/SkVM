import { test, expect, describe } from "bun:test"
import { getAllGenerators, getGenerator, getRegisteredIds } from "../../src/profiler/generators/index.ts"
import { ALL_PRIMITIVE_IDS } from "../../src/core/primitives.ts"
import type { Level } from "../../src/core/types.ts"

const LEVELS: Exclude<Level, "L0">[] = ["L1", "L2", "L3"]

describe("All 26 generators", () => {
  test("exactly 26 generators registered", () => {
    expect(getAllGenerators()).toHaveLength(26)
    expect(getRegisteredIds()).toHaveLength(26)
  })

  test("all primitive IDs have a generator", () => {
    const registered = new Set(getRegisteredIds())
    const missing = ALL_PRIMITIVE_IDS.filter((id) => !registered.has(id))
    expect(missing).toEqual([])
  })

  test("all generators match a known primitive ID", () => {
    const known = new Set(ALL_PRIMITIVE_IDS)
    for (const gen of getAllGenerators()) {
      expect(known.has(gen.primitiveId)).toBe(true)
    }
  })

  // Test each generator produces valid instances at all levels
  for (const gen of getAllGenerators()) {
    for (const level of LEVELS) {
      test(`${gen.primitiveId} ${level}: generates valid instance`, () => {
        const inst = gen.generate(level)
        expect(inst.prompt).toBeDefined()
        expect(inst.prompt.length).toBeGreaterThan(5)
        expect(inst.eval).toBeDefined()
        expect(inst.eval.method).toBe("script")
        if (inst.eval.method === "script") {
          expect(inst.eval.command.length).toBeGreaterThan(5)
        }
      })
    }
  }
})
