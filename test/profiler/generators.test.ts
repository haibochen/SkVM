import { test, expect, describe } from "bun:test"
import genCodePython from "../../src/profiler/generators/gen-code-python.ts"
import genTextStructured from "../../src/profiler/generators/gen-text-structured.ts"
import reasonArithmetic from "../../src/profiler/generators/reason-arithmetic.ts"
import type { Level } from "../../src/core/types.ts"

const LEVELS: Exclude<Level, "L0">[] = ["L1", "L2", "L3"]

describe("gen.code.python generator", () => {
  test("has correct primitiveId", () => {
    expect(genCodePython.primitiveId).toBe("gen.code.python")
  })

  for (const level of LEVELS) {
    test(`generates valid ${level} instance`, () => {
      const inst = genCodePython.generate(level)
      expect(inst.prompt.length).toBeGreaterThan(10)
      expect(inst.eval.method).toBe("script")
    })

    test(`${level} produces randomized instances`, () => {
      const a = genCodePython.generate(level)
      const b = genCodePython.generate(level)
      // Either prompts or setup files should differ due to randomization
      const aDiff = a.prompt + JSON.stringify(a.setupFiles ?? {})
      const bDiff = b.prompt + JSON.stringify(b.setupFiles ?? {})
      expect(aDiff).not.toBe(bDiff)
    })
  }

  test("L1 has input.txt setup file", () => {
    const inst = genCodePython.generate("L1")
    expect(inst.setupFiles).toBeDefined()
    expect(inst.setupFiles!["input.txt"]).toBeDefined()
    // Lines should be in "name:number" format
    const lines = inst.setupFiles!["input.txt"]!.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(5)
    for (const line of lines) {
      expect(line).toMatch(/^\w+:\d+$/)
    }
  })

  test("L2 has data.csv setup file", () => {
    const inst = genCodePython.generate("L2")
    expect(inst.setupFiles!["data.csv"]).toBeDefined()
    const lines = inst.setupFiles!["data.csv"]!.split("\n")
    expect(lines[0]).toBe("name,score,department")
    expect(lines.length).toBeGreaterThanOrEqual(6) // header + 5 rows
  })

  test("L3 has CSV setup file", () => {
    const inst = genCodePython.generate("L3")
    const csvFile = Object.keys(inst.setupFiles!).find(k => k.endsWith(".csv"))
    expect(csvFile).toBeDefined()
    const lines = inst.setupFiles![csvFile!]!.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(6) // header + rows
  })
})

describe("gen.text.structured generator", () => {
  test("has correct primitiveId", () => {
    expect(genTextStructured.primitiveId).toBe("gen.text.structured")
  })

  for (const level of LEVELS) {
    test(`generates valid ${level} instance`, () => {
      const inst = genTextStructured.generate(level)
      expect(inst.prompt.length).toBeGreaterThan(10)
      expect(inst.eval.method).toBe("script")
      // These are text-generation tasks, no setup files needed
      if (level === "L1") {
        expect(inst.setupFiles).toBeUndefined()
      }
    })

    test(`${level} produces randomized instances`, () => {
      const a = genTextStructured.generate(level)
      const b = genTextStructured.generate(level)
      expect(a.prompt).not.toBe(b.prompt)
    })
  }

  test("L1 eval checks response.txt", () => {
    const inst = genTextStructured.generate("L1")
    if (inst.eval.method === "script") {
      expect(inst.eval.command).toContain("response.txt")
    }
  })
})

describe("reason.arithmetic generator", () => {
  test("has correct primitiveId", () => {
    expect(reasonArithmetic.primitiveId).toBe("reason.arithmetic")
  })

  for (const level of LEVELS) {
    test(`generates valid ${level} instance`, () => {
      const inst = reasonArithmetic.generate(level)
      expect(inst.prompt.length).toBeGreaterThan(10)
      expect(inst.eval.method).toBe("script")
      expect(inst.setupFiles).toBeUndefined()
    })

    test(`${level} produces randomized instances`, () => {
      const a = reasonArithmetic.generate(level)
      const b = reasonArithmetic.generate(level)
      expect(a.prompt).not.toBe(b.prompt)
    })
  }

  test("L1 eval checks response.txt", () => {
    const inst = reasonArithmetic.generate("L1")
    if (inst.eval.method === "script") {
      expect(inst.eval.command).toContain("response.txt")
    }
  })

  test("L2 prompt mentions discount and tax", () => {
    const inst = reasonArithmetic.generate("L2")
    expect(inst.prompt).toContain("discount")
    expect(inst.prompt).toContain("tax")
  })

  test("L3 prompt mentions compound interest", () => {
    const inst = reasonArithmetic.generate("L3")
    expect(inst.prompt).toContain("interest")
    expect(inst.prompt).toContain("compounded")
  })
})
