import { test, expect, describe } from "bun:test"
import { runAgentLoop } from "../../src/core/agent-loop.ts"
import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../../src/providers/types.ts"

// Minimal mock LLM. Each `complete` call sleeps for `delayMs` then returns
// a final end_turn response, so the loop exits naturally after one iteration.
function mockProvider(delayMs: number): LLMProvider {
  return {
    name: "mock",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      await new Promise((r) => setTimeout(r, delayMs))
      return {
        text: "done",
        toolCalls: [],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: delayMs,
        stopReason: "end_turn",
      }
    },
    async completeWithToolResults(
      _params: CompletionParams,
      _toolResults: LLMToolResult[],
      _previousResponse: LLMResponse,
    ): Promise<LLMResponse> {
      throw new Error("not used")
    },
  }
}

describe("runAgentLoop deadline detection", () => {
  test("post-loop check catches over-time await that returned end_turn", async () => {
    // Regression for round-6 / sweep G6: the in-loop deadline check only
    // fires before a new iteration starts. If `provider.complete()` runs
    // past `timeoutMs` and then returns a final response, the loop exits
    // naturally and the in-loop check never runs. Without the post-loop
    // check, `timedOut` would stay false, and bare-agent would report
    // `runStatus: 'ok'` for an over-time run — recreating the original
    // false-positive class.
    const result = await runAgentLoop(
      {
        provider: mockProvider(200),  // takes 200ms
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 5,
        timeoutMs: 50,                  // budget is 50ms — overrun by ~150ms
      },
      [{ role: "user", content: "hello" }],
    )

    expect(result.timedOut).toBe(true)
    expect(result.iterations).toBe(1)  // one iteration happened
  })

  test("normal in-budget run is not marked timedOut", async () => {
    const result = await runAgentLoop(
      {
        provider: mockProvider(20),    // takes 20ms
        model: "mock",
        tools: [],
        executeTool: async () => ({ output: "", durationMs: 0 }),
        system: "",
        maxIterations: 5,
        timeoutMs: 5000,                // ample budget
      },
      [{ role: "user", content: "hello" }],
    )

    expect(result.timedOut).toBe(false)
    expect(result.text).toBe("done")
    expect(result.iterations).toBe(1)
  })
})
