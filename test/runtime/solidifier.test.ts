import { test, expect, describe } from "bun:test"
import { Solidifier, extractParamsFromPrompt, instantiateTemplate } from "../../src/jit-boost/solidifier.ts"
import type { BoostCandidate, SolidificationState } from "../../src/jit-boost/types.ts"
import type { LLMResponse } from "../../src/providers/types.ts"

const CANDIDATE: BoostCandidate = {
  purposeId: "fetch-weather",
  keywords: ["weather", "temperature", "forecast"],
  codeSignature: "curl.*api\\.weather\\.com.*jq",
  functionTemplate: 'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
  params: {
    city: {
      type: "string",
      description: "City name for weather query",
      extractPattern: "(?:in|for)\\s+([A-Z][a-zA-Z]+)",
    },
  },
  materializationType: "shell",
}

/** Backward-compat candidate with old-style string params */
const LEGACY_CANDIDATE: BoostCandidate = {
  purposeId: "fetch-weather-legacy",
  keywords: ["weather"],
  codeSignature: "curl.*api\\.weather\\.com.*jq",
  functionTemplate: 'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
  params: { city: "string" },
  materializationType: "shell",
}

function makeLLMResponse(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): LLMResponse {
  return {
    text: "",
    toolCalls: toolCalls.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.name,
      arguments: tc.args,
    })),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    durationMs: 0,
    stopReason: "tool_use",
  }
}

describe("Solidifier - Stage 2 (monitoring)", () => {
  test("skeleton match increments consecutiveMatches", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const entries = solidifier.getEntries()
    expect(entries[0]!.state.consecutiveMatches).toBe(1)
    expect(entries[0]!.state.hitCount).toBe(1)
    expect(entries[0]!.state.promoted).toBe(false)
  })

  test("non-matching tool call resets consecutiveMatches", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    // First match
    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temp' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(1)

    // Non-match resets
    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: "echo hello" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1) // total still 1
  })

  test("3 consecutive matches promotes candidate", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    for (let i = 1; i <= 3; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/City${i}" | jq .temperature` },
        }]),
        iteration: i,
        workDir: "/tmp",
      })
    }

    const entry = solidifier.getEntries()[0]!
    expect(entry.state.promoted).toBe(true)
    expect(entry.state.consecutiveMatches).toBe(3)
    expect(entry.promotedAt).toBeDefined()
  })

  test("2 matches + miss + 2 matches does NOT promote", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    // 2 matches
    for (let i = 0; i < 2; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/A" | jq .temperature` },
        }]),
        iteration: i,
        workDir: "/tmp",
      })
    }
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(2)

    // Miss
    await hook({
      response: makeLLMResponse([{ name: "execute_command", args: { command: "ls" } }]),
      iteration: 3,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(0)

    // 2 more matches
    for (let i = 0; i < 2; i++) {
      await hook({
        response: makeLLMResponse([{
          name: "execute_command",
          args: { command: `curl -s "https://api.weather.com/v1/B" | jq .temperature` },
        }]),
        iteration: 4 + i,
        workDir: "/tmp",
      })
    }

    expect(solidifier.getEntries()[0]!.state.consecutiveMatches).toBe(2)
    expect(solidifier.getEntries()[0]!.state.promoted).toBe(false) // NOT promoted
  })

  test("ignores non-exec/write tool calls", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "read_file",
        args: { path: 'curl api.weather.com jq' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)
  })
})

describe("extractParamsFromPrompt", () => {
  test("extracts city via regex extractPattern", async () => {
    const result = await extractParamsFromPrompt("What's the weather in Tokyo?", CANDIDATE)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.city).toBe("Tokyo")
  })

  test("extracts city via regex extractPattern (for variant)", async () => {
    const result = await extractParamsFromPrompt("Get forecast for London", CANDIDATE)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.city).toBe("London")
  })

  test("returns incomplete when regex fails and no LLM provider", async () => {
    const result = await extractParamsFromPrompt("Show me the temperature", CANDIDATE)
    expect(result.complete).toBe(false)
    expect(result.method).toBe("none")
  })

  test("legacy string params (no extractPattern) returns incomplete without LLM", async () => {
    const result = await extractParamsFromPrompt("What's the weather in Tokyo?", LEGACY_CANDIDATE)
    expect(result.complete).toBe(false)
    expect(result.method).toBe("none")
  })

  test("empty params returns complete", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {},
    }
    const result = await extractParamsFromPrompt("anything", candidate)
    expect(result.complete).toBe(true)
  })

  test("multi-param regex extraction", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {
        inputPdf: { type: "string", description: "Input PDF file", extractPattern: "(\\S+\\.pdf)" },
        outputTxt: { type: "string", description: "Output text file", extractPattern: "(\\S+\\.txt)" },
      },
    }
    const result = await extractParamsFromPrompt("Extract text from report.pdf to output.txt", candidate)
    expect(result.complete).toBe(true)
    expect(result.method).toBe("regex")
    expect(result.params.inputPdf).toBe("report.pdf")
    expect(result.params.outputTxt).toBe("output.txt")
  })

  test("partial regex extraction returns incomplete", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      params: {
        inputPdf: { type: "string", description: "Input PDF", extractPattern: "(\\S+\\.pdf)" },
        outputTxt: { type: "string", description: "Output text", extractPattern: "(\\S+\\.txt)" },
      },
    }
    // Only mentions .pdf, not .txt
    const result = await extractParamsFromPrompt("Process report.pdf", candidate)
    expect(result.complete).toBe(false)
  })
})

describe("instantiateTemplate", () => {
  test("replaces placeholders", () => {
    const result = instantiateTemplate(
      'curl -s "https://api.weather.com/v1/${city}" | jq .temperature',
      { city: "Tokyo" },
    )
    expect(result).toBe('curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature')
  })

  test("replaces multiple placeholders", () => {
    const result = instantiateTemplate(
      'python3 process.py --input ${input} --output ${output}',
      { input: "data.csv", output: "result.json" },
    )
    expect(result).toBe("python3 process.py --input data.csv --output result.json")
  })

  test("leaves unknown placeholders as-is", () => {
    const result = instantiateTemplate('echo ${unknown}', {})
    expect(result).toBe("echo ${unknown}")
  })
})

describe("Solidifier - state restoration", () => {
  test("restores promotion state from persisted data", () => {
    const savedState: SolidificationState = {
      skillId: "weather",
      entries: [{
        candidate: CANDIDATE,
        state: {
          candidateId: "fetch-weather",
          hitCount: 10,
          consecutiveMatches: 3,
          promoted: true,
          fallbackCount: 0,
        },
        promotedAt: "2026-04-04T00:00:00Z",
      }],
      updatedAt: "2026-04-04T00:00:00Z",
    }

    const solidifier = new Solidifier([CANDIDATE], { savedState })
    const entries = solidifier.getEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.state.promoted).toBe(true)
    expect(entries[0]!.state.hitCount).toBe(10)
    expect(entries[0]!.state.consecutiveMatches).toBe(3)
    expect(entries[0]!.promotedAt).toBe("2026-04-04T00:00:00Z")
  })

  test("fresh init when no saved state", () => {
    const solidifier = new Solidifier([CANDIDATE])
    const entries = solidifier.getEntries()

    expect(entries).toHaveLength(1)
    expect(entries[0]!.state.promoted).toBe(false)
    expect(entries[0]!.state.hitCount).toBe(0)
  })
})

describe("Solidifier - exportState", () => {
  test("exports current state for persistence", () => {
    const solidifier = new Solidifier([CANDIDATE])
    const exported = solidifier.exportState("weather")

    expect(exported.skillId).toBe("weather")
    expect(exported.entries).toHaveLength(1)
    expect(exported.entries[0]!.candidate.purposeId).toBe("fetch-weather")
    expect(exported.updatedAt).toBeDefined()
  })

  test("exports updated state after monitoring", async () => {
    const solidifier = new Solidifier([CANDIDATE])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl -s "https://api.weather.com/v1/Tokyo" | jq .temperature' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const exported = solidifier.exportState("weather")
    expect(exported.entries[0]!.state.hitCount).toBe(1)
    expect(exported.entries[0]!.state.consecutiveMatches).toBe(1)
  })
})

describe("Solidifier - configurable monitor scope", () => {
  test("web_fetch is monitored by default", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "weather\\.com",
    }
    const solidifier = new Solidifier([candidate])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "web_fetch",
        args: { url: "https://api.weather.com/v1/Tokyo" },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })

    const entries = solidifier.getEntries()
    expect(entries[0]!.state.hitCount).toBe(1)
  })

  test("per-candidate monitoredTools override", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "weather\\.com",
      monitoredTools: ["web_fetch"],
    }
    const solidifier = new Solidifier([candidate])
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: 'curl https://api.weather.com/v1/Tokyo' },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)

    await hook({
      response: makeLLMResponse([{
        name: "web_fetch",
        args: { url: "https://api.weather.com/v1/Tokyo" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1)
  })

  test("custom default monitored tools", async () => {
    const candidate: BoostCandidate = {
      ...CANDIDATE,
      codeSignature: "test",
    }
    const solidifier = new Solidifier([candidate], { monitoredTools: new Set(["read_file"]) })
    const hook = solidifier.createAfterLLMHook()

    await hook({
      response: makeLLMResponse([{
        name: "execute_command",
        args: { command: "test" },
      }]),
      iteration: 1,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(0)

    await hook({
      response: makeLLMResponse([{
        name: "read_file",
        args: { path: "test" },
      }]),
      iteration: 2,
      workDir: "/tmp",
    })
    expect(solidifier.getEntries()[0]!.state.hitCount).toBe(1)
  })
})
