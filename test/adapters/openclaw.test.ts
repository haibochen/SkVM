import { test, expect, describe } from "bun:test"
import { normalizeAgentId } from "../../src/adapters/openclaw.ts"

describe("normalizeAgentId", () => {
  test("lowercases and replaces slashes, dots, and colons with dashes", () => {
    expect(normalizeAgentId("anthropic/claude-haiku-4.5")).toBe("anthropic-claude-haiku-4-5")
    expect(normalizeAgentId("qwen:qwen3.5-9b")).toBe("qwen-qwen3-5-9b")
    expect(normalizeAgentId("OpenAI/GPT-5.4")).toBe("openai-gpt-5-4")
  })

  test("leaves already-safe IDs unchanged", () => {
    expect(normalizeAgentId("plain-model-id")).toBe("plain-model-id")
  })
})
