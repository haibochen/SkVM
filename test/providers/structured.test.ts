import { test, expect, describe } from "bun:test"
import { z } from "zod"
import { extractStructured } from "../../src/providers/structured.ts"
import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../../src/providers/types.ts"

// Mock provider that supports tool_use
function createMockToolProvider(toolCallArgs: Record<string, unknown>): LLMProvider {
  return {
    name: "mock-tool",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      return {
        text: "",
        toolCalls: [{ id: "tc_1", name: "extract", arguments: toolCallArgs }],
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        stopReason: "tool_use",
      }
    },
    async completeWithToolResults() {
      throw new Error("not needed")
    },
  }
}

// Mock provider that returns no tool calls (falls through to prompt+parse).
// Layer 1 sees zero toolCalls, throws, layer 2 takes over and parses the
// returned text as JSON.
function createMockPromptProvider(jsonResponse: string): LLMProvider {
  return {
    name: "mock-prompt",
    async complete(_params: CompletionParams): Promise<LLMResponse> {
      return {
        text: jsonResponse,
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
}

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
})

describe("extractStructured", () => {
  test("extracts via tool_use when supported", async () => {
    const provider = createMockToolProvider({ name: "Alice", age: 30 })
    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract the person's name and age from: Alice is 30 years old.",
    })
    expect(result.name).toBe("Alice")
    expect(result.age).toBe(30)
  })

  test("extracts via prompt+parse when tool_use not supported", async () => {
    const provider = createMockPromptProvider('{"name": "Bob", "age": 25}')
    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract the person's name and age from: Bob is 25 years old.",
    })
    expect(result.name).toBe("Bob")
    expect(result.age).toBe(25)
  })

  test("handles markdown fences in prompt+parse fallback", async () => {
    const provider = createMockPromptProvider('```json\n{"name": "Carol", "age": 40}\n```')
    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract person info.",
    })
    expect(result.name).toBe("Carol")
    expect(result.age).toBe(40)
  })

  test("tool_use provider returning empty tool calls triggers prompt fallback", async () => {
    let callCount = 0
    const provider: LLMProvider = {
      name: "mock-fallback",
      async complete(_params: CompletionParams): Promise<LLMResponse> {
        callCount++
        const body = callCount === 1
          ? { text: "I cannot use tools", toolCalls: [] }
          : { text: '{"name": "Dave", "age": 35}', toolCalls: [] }
        return {
          ...body,
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: callCount === 1 ? "end_turn" : "end_turn",
        }
      },
      async completeWithToolResults() {
        throw new Error("not needed")
      },
    }

    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract person info: Dave is 35.",
    })
    expect(result.name).toBe("Dave")
    expect(callCount).toBe(2)
  })

  test("prompt+parse rejects when response contains no JSON", async () => {
    const provider = createMockPromptProvider("I cannot help with that request.")
    await expect(
      extractStructured({
        provider,
        schema: PersonSchema,
        schemaName: "extract_person",
        schemaDescription: "Extract person info",
        prompt: "Extract info.",
      }),
    ).rejects.toThrow()
  })

  test("validates against Zod schema - rejects invalid data", async () => {
    const provider = createMockToolProvider({ name: "Eve", age: "not a number" })
    await expect(
      extractStructured({
        provider,
        schema: PersonSchema,
        schemaName: "extract_person",
        schemaDescription: "Extract person info",
        prompt: "Extract info.",
      })
    ).rejects.toThrow()
  })

  test("tool_use path forwards toolChoice: { name } to force schema container", async () => {
    // Ensures Layer 1 of extractStructured pins the model to a specific tool
    // rather than letting it choose, so the model can't decline structured
    // output and bounce us to the slower prompt+parse fallback.
    const calls: CompletionParams[] = []
    const provider: LLMProvider = {
      name: "spy",
      async complete(params) {
        calls.push(params)
        return {
          text: "",
          toolCalls: [{ id: "tc_1", name: "extract_person", arguments: { name: "Frank", age: 50 } }],
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          durationMs: 0,
          stopReason: "tool_use",
        }
      },
      async completeWithToolResults() {
        throw new Error("not needed")
      },
    }
    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract info.",
    })
    expect(result).toEqual({ name: "Frank", age: 50 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolChoice).toEqual({ name: "extract_person" })
    expect(calls[0]!.tools?.[0]?.name).toBe("extract_person")
  })

  test("falls back to prompt+parse if tool_use throws (e.g. provider rejects tools)", async () => {
    // Simulates a model that errors on tool_use entirely. Layer 1 throws,
    // Layer 2 takes over and parses the JSON returned by the second call.
    let attempt = 0
    const provider: LLMProvider = {
      name: "broken-tool-use",
      async complete(_params) {
        attempt++
        if (attempt === 1) {
          throw new Error("simulated tool_use rejection from provider")
        }
        return {
          text: '{"name": "Greta", "age": 28}',
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
    const { result } = await extractStructured({
      provider,
      schema: PersonSchema,
      schemaName: "extract_person",
      schemaDescription: "Extract person info",
      prompt: "Extract info.",
    })
    expect(result).toEqual({ name: "Greta", age: 28 })
    expect(attempt).toBe(2)
  })

  test("works with complex nested schemas", async () => {
    const ComplexSchema = z.object({
      skillName: z.string(),
      purposes: z.array(z.object({
        id: z.string(),
        primitives: z.array(z.string()),
      })),
    })

    const data = {
      skillName: "test-skill",
      purposes: [{ id: "p1", primitives: ["gen.code.python", "tool.exec"] }],
    }
    const provider = createMockToolProvider(data)
    const { result } = await extractStructured({
      provider,
      schema: ComplexSchema,
      schemaName: "extract_scr",
      schemaDescription: "Extract SCR",
      prompt: "Analyze this skill.",
    })
    expect(result.skillName).toBe("test-skill")
    expect(result.purposes).toHaveLength(1)
    expect(result.purposes[0]!.primitives).toContain("gen.code.python")
  })
})
