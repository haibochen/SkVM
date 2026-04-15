import { test, expect, describe } from "bun:test"
import { validateGuard } from "../../src/compiler/guard.ts"
import type { Transform } from "../../src/core/types.ts"

describe("validateGuard", () => {
  test("passes when compiled is identical to original", () => {
    const skill = "# My Skill\n\nDo things.\n"
    const result = validateGuard(skill, skill)
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  test("passes when compiled adds small content", () => {
    const original = "# My Skill\n\nStep 1.\nStep 2.\nStep 3.\nStep 4.\nStep 5.\n"
    const compiled = original + "\n> Added note.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("fails when compiled exceeds tiered length limit", () => {
    // Short document (<100 lines) gets 2x expansion budget
    // 4-line original → max 8 added lines → 12 total max
    const original = "# Skill\n\nLine 1\nLine 2\n"
    const compiled = original + "\n".repeat(5) + "A\n".repeat(10) // adds 15 lines, exceeds 2x budget of 8
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  test("uses generous 2x limit for short skills (<100 lines)", () => {
    // 10-line original → max 20 added → 30 total
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n")
    const added = Array.from({ length: 19 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + added)
    expect(result.passed).toBe(true)
  })

  test("uses 1x limit for medium skills (100-200 lines)", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join("\n")
    // 150-line original → max 150 added
    const tooMuch = Array.from({ length: 160 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + tooMuch)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  test("uses strict 0.5x limit for long skills (>200 lines)", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`).join("\n")
    // 300-line original → max 150 added
    const tooMuch = Array.from({ length: 160 }, (_, i) => `Added ${i}`).join("\n")
    const result = validateGuard(lines, lines + "\n" + tooMuch)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Length"))).toBe(true)
  })

  test("fails when code block is removed", () => {
    const original = "# Skill\n\n```python\nprint('hello world')\nresult = compute()\n```\n\nMore text.\n"
    const compiled = "# Skill\n\nMore text.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Code block"))).toBe(true)
  })

  test("passes when code blocks are preserved", () => {
    const original = "# Skill\n\n```python\nprint('hello')\n```\n\nMore text.\n"
    const compiled = "# Skill\n\n> Added compensation.\n\n```python\nprint('hello')\n```\n\nMore text.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("fails when frontmatter is modified", () => {
    const original = "---\nname: my-skill\nversion: 1.0\n---\n\n# Skill\n\nContent.\n"
    const compiled = "---\nname: modified-skill\nversion: 2.0\n---\n\n# Skill\n\nContent.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Frontmatter"))).toBe(true)
  })

  test("passes when frontmatter is preserved", () => {
    const original = "---\nname: my-skill\n---\n\n# Skill\n\nContent.\n"
    const compiled = "---\nname: my-skill\n---\n\n# Skill\n\n> Added compensation.\n\nContent.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("passes when no frontmatter in either", () => {
    const original = "# Skill\n\nContent.\n"
    const compiled = "# Skill\n\n> Note.\n\nContent.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("passes when substitution replace removes a code block", () => {
    const original = "# Skill\n\n## Data\n\n```python\nimport pandas\ndf = pandas.read_csv('data.csv')\n```\n\nMore text.\n"
    const compiled = "# Skill\n\n## Data\n\n```sql\nSELECT * FROM data;\n```\n\nMore text.\n"
    const transforms: Transform[] = [{
      type: "substitution",
      purposeId: "p1",
      primitiveId: "gen.code.python",
      targetSection: "Data",
      action: "replace",
      description: "Replace pandas with SQL",
      content: "## Data\n\n```sql\nSELECT * FROM data;\n```",
      original: "## Data\n\n```python\nimport pandas\ndf = pandas.read_csv('data.csv')\n```",
    }]
    const result = validateGuard(original, compiled, transforms)
    expect(result.passed).toBe(true)
  })

  test("fails when non-substituted code block is removed", () => {
    const original = "# Skill\n\n```python\nprint('hello world')\nresult = compute()\n```\n\nMore text.\n"
    const compiled = "# Skill\n\nMore text.\n"
    // No substitution transforms — code block removal is a violation
    const result = validateGuard(original, compiled, [])
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Code block"))).toBe(true)
  })

  // --- Heading preservation tests ---

  test("passes when headings are identical", () => {
    const original = "# Title\n\n## Section A\n\nContent.\n\n## Section B\n\nMore.\n"
    const compiled = "# Title\n\n## Section A\n\nEdited content.\n\n## Section B\n\nMore with hints.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })

  test("fails when a heading is added", () => {
    const original = "# Title\n\n## Section A\n\nContent.\n"
    const compiled = "# Title\n\n## Section A\n\nContent.\n\n## Section B\n\nNew section.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Heading added"))).toBe(true)
  })

  test("fails when a heading is removed", () => {
    const original = "# Title\n\n## Section A\n\nContent.\n\n## Section B\n\nMore.\n"
    const compiled = "# Title\n\nContent and more.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Heading removed"))).toBe(true)
  })

  test("fails when heading text is changed", () => {
    const original = "# Title\n\n## Section A\n\nContent.\n"
    const compiled = "# Title\n\n## Renamed Section\n\nContent.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.includes("Heading changed"))).toBe(true)
  })

  test("ignores headings inside code blocks", () => {
    const original = "# Title\n\n```markdown\n# Not a real heading\n## Also not real\n```\n\nContent.\n"
    // Same code block content preserved, only real heading matters
    const compiled = "# Title\n\n```markdown\n# Not a real heading\n## Also not real\n```\n\nEdited content.\n"
    const result = validateGuard(original, compiled)
    expect(result.passed).toBe(true)
  })
})
