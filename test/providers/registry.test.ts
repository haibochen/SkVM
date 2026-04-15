import { test, expect, describe } from "bun:test"
import {
  globMatch,
  findMatchingRoute,
  createProviderForModel,
  stripRoutingPrefix,
} from "../../src/providers/registry.ts"
import { ProviderAuthError } from "../../src/providers/errors.ts"
import type { ProvidersConfig } from "../../src/core/types.ts"

describe("globMatch", () => {
  test("literal match", () => {
    expect(globMatch("anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6")).toBe(true)
    expect(globMatch("anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5")).toBe(false)
  })

  test("wildcard suffix", () => {
    expect(globMatch("anthropic/*", "anthropic/claude-sonnet-4-6")).toBe(true)
    expect(globMatch("anthropic/*", "anthropic/claude-haiku-4-5")).toBe(true)
    expect(globMatch("anthropic/*", "openai/gpt-4o")).toBe(false)
  })

  test("wildcard in middle", () => {
    expect(globMatch("openai/gpt-*", "openai/gpt-4o")).toBe(true)
    expect(globMatch("openai/gpt-*", "openai/gpt-4o-mini")).toBe(true)
    expect(globMatch("openai/gpt-*", "openai/o1-preview")).toBe(false)
  })

  test("catch-all", () => {
    expect(globMatch("*", "anything/at/all")).toBe(true)
    expect(globMatch("*", "")).toBe(true)
  })

  test("regex metacharacters in pattern are literal", () => {
    // Dot should not match any char; it should match a literal dot.
    expect(globMatch("a.b", "a.b")).toBe(true)
    expect(globMatch("a.b", "axb")).toBe(false)
  })
})

describe("findMatchingRoute", () => {
  const config: ProvidersConfig = {
    routes: [
      { match: "anthropic/*", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      { match: "openai/*", kind: "openai-compatible", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
      { match: "*", kind: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
    ],
  }

  test("first match wins — specific route before catch-all", () => {
    const route = findMatchingRoute("anthropic/claude-sonnet-4-6", config)
    expect(route?.kind).toBe("anthropic")
  })

  test("catch-all picks up unmatched ids", () => {
    const route = findMatchingRoute("qwen/qwen3-30b", config)
    expect(route?.kind).toBe("openrouter")
  })

  test("order matters — earlier specific wins over later catch-all", () => {
    const route = findMatchingRoute("openai/gpt-4o", config)
    expect(route?.kind).toBe("openai-compatible")
  })

  test("no routes → undefined", () => {
    expect(findMatchingRoute("anything", { routes: [] })).toBeUndefined()
  })
})

describe("stripRoutingPrefix", () => {
  test("drops the first /-separated segment", () => {
    expect(stripRoutingPrefix("openai/gpt-4o")).toBe("gpt-4o")
    expect(stripRoutingPrefix("self/qwen3-7b")).toBe("qwen3-7b")
    expect(stripRoutingPrefix("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
  })

  test("preserves nested paths after the first segment", () => {
    // A vLLM backend exposing hierarchical aliases like "meta-llama/Llama-3-70B"
    // should see exactly that — only the routing prefix comes off.
    expect(stripRoutingPrefix("openai/meta-llama/Llama-3-70B")).toBe("meta-llama/Llama-3-70B")
  })

  test("no-op for bare ids", () => {
    expect(stripRoutingPrefix("gpt-4o")).toBe("gpt-4o")
    expect(stripRoutingPrefix("")).toBe("")
  })
})

describe("createProviderForModel", () => {
  test("falls back to OpenRouter when no config is present", () => {
    // apiKey override bypasses env var lookup so the test doesn't depend on
    // OPENROUTER_API_KEY being set in the environment.
    const provider = createProviderForModel("qwen/qwen3-30b-a3b-instruct-2507", {
      apiKey: "test-key",
    })
    expect(provider.name).toBe("openrouter")
  })

  test("overrides.apiKey bypasses the route's apiKeyEnv", () => {
    // Even if the default OPENROUTER_API_KEY is unset in the test env, the
    // override key lets us instantiate the provider without throwing.
    const provider = createProviderForModel("some/model", { apiKey: "fake" })
    expect(provider).toBeDefined()
  })

  test("missing env var throws ProviderAuthError", () => {
    // Save + clear OPENROUTER_API_KEY so the default route's apiKeyEnv lookup
    // fails. Not using overrides — this test is specifically about the env-var
    // failure path producing a classifiable infra error.
    const saved = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    try {
      let thrown: unknown
      try {
        createProviderForModel("qwen/qwen3-30b")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(ProviderAuthError)
      expect((thrown as ProviderAuthError).retryable).toBe(false)
      expect((thrown as Error).message).toContain("OPENROUTER_API_KEY")
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved
    }
  })
})
