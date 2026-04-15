import { describe, expect, test } from "bun:test"
import { buildOptimizerPrompt } from "../../src/jit-optimize/optimizer.ts"

/**
 * Prompt contract tests. These assert that specific load-bearing phrases the
 * rest of the system depends on stay in the prompt. They intentionally do
 * NOT try to validate full wording — the point is to catch accidental
 * regressions when the prompt is edited.
 */
describe("buildOptimizerPrompt", () => {
  test("references the task-first workspace layout", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("PER_TASK_SUMMARY.md")
    expect(p).toContain("tasks/<safeTaskId>")
    expect(p).toContain("run-N.md")
  })

  test("requires reading PER_TASK_SUMMARY before the per-task directories", () => {
    const p = buildOptimizerPrompt(4, 0)
    const summaryIdx = p.indexOf("PER_TASK_SUMMARY.md")
    const taskDirIdx = p.indexOf("tasks/<safeTaskId>")
    expect(summaryIdx).toBeGreaterThan(-1)
    expect(taskDirIdx).toBeGreaterThan(-1)
    expect(summaryIdx).toBeLessThan(taskDirIdx)
  })

  test("contains the Pre-Edit Checklist 5(d) No-trade-off test", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("No-trade-off test")
    // Language that should survive edits — it is what the rule is about.
    expect(p).toContain("PASSING")
    expect(p).toContain("per-task regression gate")
  })

  test("contains the Hard Rule 'No task trade-off' invoking Pareto-non-inferiority", () => {
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("No task trade-off")
    expect(p).toContain("Pareto-non-inferior")
  })

  test("keeps the existing generality + task-content-agnostic guards", () => {
    // These are the prior defences against content overfitting. The new
    // No-trade-off rule is orthogonal — if the prior rules get deleted
    // by accident, this test catches it.
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("Generality test")
    expect(p).toContain("Task-content-agnostic")
  })

  test("history section appears only when historyCount > 0", () => {
    const none = buildOptimizerPrompt(2, 0)
    expect(none).not.toContain("history.md")
    const some = buildOptimizerPrompt(2, 3)
    expect(some).toContain("history.md")
    expect(some).toContain("3 previous optimization round(s)")
  })

  test("Evidence Indices contract for blockedEvidenceIds is still present", () => {
    // Downstream validation reads `blockedEvidenceIds` as indices matching
    // the global flat numbering shown in PER_TASK_SUMMARY.md. The prompt
    // must tell the optimizer to use that numbering, not the per-task
    // local numbering.
    const p = buildOptimizerPrompt(4, 0)
    expect(p).toContain("Evidence Indices")
    expect(p).toContain("blockedEvidenceIds")
  })
})
