import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluate, evaluateAll } from "../../src/framework/evaluator.ts"
import { registerCustomEvaluator } from "../../src/framework/types.ts"
import type { RunResult, EvalCriterion } from "../../src/core/types.ts"
import type { LLMProvider, LLMResponse, CompletionParams } from "../../src/providers/types.ts"

let workDir: string

const baseResult: RunResult = {
  text: "Done",
  steps: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  durationMs: 0,
  llmDurationMs: 0,
  workDir: "",
  runStatus: "ok",
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "skvm-test-"))
  baseResult.workDir = workDir
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe("script eval", () => {
  test("passes when exit code matches", async () => {
    await Bun.write(path.join(workDir, "data.txt"), "a\nb\nc\n")
    const result = await evaluate(
      { method: "script", command: "wc -l < data.txt", expectedExitCode: 0 },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1.0)
  })

  test("fails when exit code doesn't match", async () => {
    const result = await evaluate(
      { method: "script", command: "false", expectedExitCode: 0 },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0.0)
  })

  test("checks expected output", async () => {
    await Bun.write(path.join(workDir, "out.txt"), "hello")
    const result = await evaluate(
      { method: "script", command: "cat out.txt", expectedExitCode: 0, expectedOutput: "hello" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
  })

  test("fails on output mismatch", async () => {
    await Bun.write(path.join(workDir, "out.txt"), "world")
    const result = await evaluate(
      { method: "script", command: "cat out.txt", expectedExitCode: 0, expectedOutput: "hello" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
  })
})

describe("file-check eval", () => {
  test("exact match passes", async () => {
    await Bun.write(path.join(workDir, "result.txt"), "42")
    const result = await evaluate(
      { method: "file-check", path: "result.txt", mode: "exact", expected: "42" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
  })

  test("exact match fails", async () => {
    await Bun.write(path.join(workDir, "result.txt"), "43")
    const result = await evaluate(
      { method: "file-check", path: "result.txt", mode: "exact", expected: "42" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
  })

  test("file not found", async () => {
    const result = await evaluate(
      { method: "file-check", path: "missing.txt", mode: "exact", expected: "x" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
    expect(result.details).toContain("not found")
  })

  test("contains mode", async () => {
    await Bun.write(path.join(workDir, "log.txt"), "INFO: operation completed successfully")
    const result = await evaluate(
      { method: "file-check", path: "log.txt", mode: "contains", expected: "completed successfully" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
  })

  test("regex mode", async () => {
    await Bun.write(path.join(workDir, "out.txt"), "Total: 123 items")
    const result = await evaluate(
      { method: "file-check", path: "out.txt", mode: "regex", expected: "Total: \\d+ items" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
  })

  test("regex mode fails", async () => {
    await Bun.write(path.join(workDir, "out.txt"), "No numbers here")
    const result = await evaluate(
      { method: "file-check", path: "out.txt", mode: "regex", expected: "\\d+" },
      { ...baseResult, workDir },
    )
    // "No numbers here" doesn't match \d+ ... wait, actually it has no digits, but let me re-check.
    // Oh wait, "here" has no digits, so \d+ won't match. But the regex is applied to the full content.
    expect(result.pass).toBe(false)
  })

  test("json-schema mode", async () => {
    await Bun.write(path.join(workDir, "data.json"), JSON.stringify({ name: "Alice", age: 30 }))
    const schema = JSON.stringify({
      type: "object",
      required: ["name", "age"],
    })
    const result = await evaluate(
      { method: "file-check", path: "data.json", mode: "json-schema", expected: schema },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
  })

  test("json-schema fails when key missing", async () => {
    await Bun.write(path.join(workDir, "data.json"), JSON.stringify({ name: "Alice" }))
    const schema = JSON.stringify({
      type: "object",
      required: ["name", "age"],
    })
    const result = await evaluate(
      { method: "file-check", path: "data.json", mode: "json-schema", expected: schema },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
  })
})

describe("llm-judge eval", () => {
  test("returns score from LLM", async () => {
    const mockProvider: LLMProvider = {
      name: "mock",
      async complete(): Promise<LLMResponse> {
        return {
          text: '{"score": 0.8, "reasoning": "Good output"}',
          toolCalls: [],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "end_turn",
        }
      },
      async completeWithToolResults() {
        throw new Error("not needed")
      },
    }

    const result = await evaluate(
      { method: "llm-judge", rubric: "Check if output is correct", maxScore: 1.0 },
      { ...baseResult, workDir },
      { llmProvider: mockProvider },
    )
    expect(result.pass).toBe(true)
    expect(result.score).toBe(0.8)
    expect(result.details).toBe("Good output")
  })

  test("coerces numeric-string score from open-weight tool_use (glm/qwen)", async () => {
    // glm-5.1 and other open-weight models' function-calling adapters emit
    // numeric fields as strings in tool_use args ({"score": "0.85"}), which
    // used to violate z.number() and bounce every judge call to prompt+parse.
    // z.coerce.number() in JudgeResponseSchema accepts this shape directly.
    const mockProvider: LLMProvider = {
      name: "mock-glm-tool-use",
      async complete(): Promise<LLMResponse> {
        return {
          text: "",
          toolCalls: [{
            id: "tc_1",
            name: "submit_score",
            arguments: { score: "0.85", reasoning: "String-typed score field" },
          }],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "tool_use",
        }
      },
      async completeWithToolResults() {
        throw new Error("not needed")
      },
    }
    const result = await evaluate(
      { method: "llm-judge", rubric: "Check something", maxScore: 1.0 },
      { ...baseResult, workDir },
      { llmProvider: mockProvider },
    )
    expect(result.pass).toBe(true)
    expect(result.score).toBe(0.85)
    expect(result.details).toBe("String-typed score field")
  })

  test("fails without provider", async () => {
    const result = await evaluate(
      { method: "llm-judge", rubric: "Check something", maxScore: 1.0 },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
    expect(result.details).toContain("requires an llmProvider")
  })

  test("fails gracefully when provider returns non-JSON", async () => {
    const mockProvider: LLMProvider = {
      name: "mock-bad-json",
      async complete(): Promise<LLMResponse> {
        return {
          text: "I cannot help with that.",
          toolCalls: [],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "end_turn",
        }
      },
      async completeWithToolResults() {
        throw new Error("not needed")
      },
    }

    const result = await evaluate(
      { method: "llm-judge", rubric: "Check something", maxScore: 1.0 },
      { ...baseResult, workDir },
      { llmProvider: mockProvider },
    )
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
  })
})

describe("custom eval", () => {
  test("calls registered evaluator and framework attaches criterion", async () => {
    registerCustomEvaluator("always-pass", {
      async run() {
        return { pass: true, score: 1.0, details: "Custom pass" }
      },
    })

    const result = await evaluate(
      { method: "custom", evaluatorId: "always-pass", id: "my-custom", name: "My Custom Check", weight: 0.42 },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(true)
    // The framework owns criterion attachment — the evaluator MUST NOT be
    // able to overwrite id/name/weight. Verify they survived.
    expect(result.criterion.id).toBe("my-custom")
    expect(result.criterion.name).toBe("My Custom Check")
    expect(result.criterion.weight).toBe(0.42)
  })

  test("fails for unknown evaluator", async () => {
    const result = await evaluate(
      { method: "custom", evaluatorId: "nonexistent" },
      { ...baseResult, workDir },
    )
    expect(result.pass).toBe(false)
    expect(result.details).toContain("not found")
  })

  test("evaluator sees the criterion (including payload)", async () => {
    let receivedPayload: unknown = undefined
    registerCustomEvaluator("payload-reader", {
      async run({ criterion }) {
        receivedPayload = criterion.payload
        return { pass: true, score: 1.0, details: "ok" }
      },
    })

    await evaluate(
      { method: "custom", evaluatorId: "payload-reader", payload: { magic: 123 } },
      { ...baseResult, workDir },
    )
    expect(receivedPayload).toEqual({ magic: 123 })
  })
})

describe("evaluateAll", () => {
  test("runs multiple criteria", async () => {
    await Bun.write(path.join(workDir, "result.txt"), "42")
    const criteria: EvalCriterion[] = [
      { method: "file-check", path: "result.txt", mode: "exact", expected: "42" },
      { method: "script", command: "test -f result.txt", expectedExitCode: 0 },
    ]
    const results = await evaluateAll(criteria, { ...baseResult, workDir })
    expect(results).toHaveLength(2)
    expect(results[0]!.pass).toBe(true)
    expect(results[1]!.pass).toBe(true)
  })
})
