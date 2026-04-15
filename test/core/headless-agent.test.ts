import { test, expect, describe } from "bun:test"
import { prefixModel } from "../../src/core/headless-agent.ts"

describe("prefixModel", () => {
  test("prepends prefix when absent", () => {
    expect(prefixModel("qwen/qwen3-30b-a3b-instruct-2507", "openrouter/"))
      .toBe("openrouter/qwen/qwen3-30b-a3b-instruct-2507")
  })

  test("idempotent — does not double-prefix", () => {
    expect(prefixModel("openrouter/qwen/qwen3-30b", "openrouter/"))
      .toBe("openrouter/qwen/qwen3-30b")
  })

  test("pass-through with empty prefix", () => {
    expect(prefixModel("anthropic/claude-sonnet-4-6", ""))
      .toBe("anthropic/claude-sonnet-4-6")
    expect(prefixModel("some-bare-id", ""))
      .toBe("some-bare-id")
  })

  test("alternate prefix routes headless-agent to a different opencode provider", () => {
    expect(prefixModel("claude-sonnet-4-6", "anthropic/"))
      .toBe("anthropic/claude-sonnet-4-6")
  })
})
