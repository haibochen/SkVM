import { test, expect, describe } from "bun:test"
import { profilePrimitive, type ProfileConfig } from "../../src/profiler/runner.ts"
import type { MicrobenchmarkGenerator } from "../../src/profiler/types.ts"
import type { AgentAdapter, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"

/** Mock adapter that returns a controllable text response */
function createMockAdapter(responseText: string): AgentAdapter {
  return {
    name: "mock",
    async setup() {},
    async run(task): Promise<RunResult> {
      return {
        text: responseText,
        steps: [{ role: "assistant", text: responseText, toolCalls: [], timestamp: Date.now() }],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 10,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
    async teardown() {},
  }
}

/** Mock adapter that fakes a timeout-killed run with residual workDir output. */
function createTaintedMockAdapter(): AgentAdapter {
  return {
    name: "mock-tainted",
    async setup() {},
    async run(task): Promise<RunResult> {
      // Plant the exact text the eval script would otherwise pass on, so any
      // missing gate would falsely score this as a pass.
      await Bun.write(`${task.workDir}/response.txt`, "ok")
      return {
        text: "ok",
        steps: [],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 300_000,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: "timeout",
        statusDetail: "mock subprocess killed after 300000ms",
      }
    },
    async teardown() {},
  }
}

const config: ProfileConfig = { instancesPerLevel: 1 }

describe("profilePrimitive", () => {
  test("model passes all levels: records L3", async () => {
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.allpass",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(_level) {
        return {
          prompt: "Test",
          eval: { method: "script", command: "echo ok", expectedExitCode: 0, expectedOutput: "ok" },
        }
      },
    }
    const adapter = createMockAdapter("any")
    const result = await profilePrimitive(gen, adapter, config)

    expect(result.highestLevel).toBe("L3")
    // All three levels should be run
    expect(result.levelResults).toHaveLength(3)
  })

  test("model fails L3, passes L1 and L2: records L2", async () => {
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.l2only",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(level) {
        const shouldPass = level !== "L3"
        return {
          prompt: `Test ${level}`,
          eval: {
            method: "script",
            command: shouldPass ? "echo ok" : 'echo "fail"; exit 1',
            expectedExitCode: 0,
            expectedOutput: "ok",
          },
        }
      },
    }
    const adapter = createMockAdapter("any")
    const result = await profilePrimitive(gen, adapter, config)

    expect(result.highestLevel).toBe("L2")
    expect(result.levelResults).toHaveLength(3) // all levels run
  })

  test("model fails all: records L0", async () => {
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.none",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(_level) {
        return {
          prompt: "Test",
          eval: {
            method: "script",
            command: 'echo "fail"; exit 1',
            expectedExitCode: 0,
            expectedOutput: "ok",
          },
        }
      },
    }
    const adapter = createMockAdapter("any")
    const result = await profilePrimitive(gen, adapter, config)

    expect(result.highestLevel).toBe("L0")
    expect(result.levelResults).toHaveLength(3)
  })

  test("multiple instances: all must pass for level to pass", async () => {
    let instanceIndex = 0
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.partial",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(level) {
        instanceIndex++
        // L3: first instance passes, second fails
        const shouldPass = level !== "L3" || instanceIndex % 2 === 1
        return {
          prompt: `Test ${level} instance ${instanceIndex}`,
          eval: {
            method: "script",
            command: shouldPass ? "echo ok" : 'echo "fail"; exit 1',
            expectedExitCode: 0,
            expectedOutput: "ok",
          },
        }
      },
    }
    const adapter = createMockAdapter("any")
    const result = await profilePrimitive(gen, adapter, {
      instancesPerLevel: 2,
    })

    // L3 fails (1/2), L1 and L2 pass
    expect(result.highestLevel).toBe("L2")
    expect(result.levelResults).toHaveLength(3) // all levels run
  })

  test("only L1 and L3 pass: records L3 (highest passing)", async () => {
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.gap",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(level) {
        const shouldPass = level !== "L2"
        return {
          prompt: `Test ${level}`,
          eval: {
            method: "script",
            command: shouldPass ? "echo ok" : 'echo "fail"; exit 1',
            expectedExitCode: 0,
            expectedOutput: "ok",
          },
        }
      },
    }
    const adapter = createMockAdapter("any")
    const result = await profilePrimitive(gen, adapter, config)

    expect(result.highestLevel).toBe("L3")
    expect(result.levelResults).toHaveLength(3)
  })

  test("tainted adapter run is not scored against residual workDir", async () => {
    // Regression for sweep G2: profiler did not gate on adapter runStatus.
    // A timeout-killed run with response.txt left in the workDir would
    // otherwise be scored as a pass by `echo ok`-style eval scripts.
    const gen: MicrobenchmarkGenerator = {
      primitiveId: "test.tainted",
      descriptions: { L1: "Test L1", L2: "Test L2", L3: "Test L3" },
      generate(_level) {
        return {
          // The adapter writes "ok" to response.txt before reporting timeout.
          // A naive evaluator would read response.txt and pass.
          prompt: "Test",
          eval: { method: "script", command: "cat response.txt", expectedExitCode: 0, expectedOutput: "ok" },
        }
      },
    }
    const adapter = createTaintedMockAdapter()
    const result = await profilePrimitive(gen, adapter, config)

    // No level should pass — the gate must have skipped eval on every level.
    // (profilePrimitive falls back to "L0" when no level passes.)
    expect(result.highestLevel).toBe("L0")
    for (const lvl of result.levelResults) {
      expect(lvl.passed).toBe(false)
      expect(lvl.instances.every(i => !i.passed)).toBe(true)
      // Failure detail should mention the runStatus, not an eval-script failure.
      expect(lvl.instances[0]!.details).toContain("tainted")
    }
  })
})
