import { test, expect, describe } from "bun:test"
import { runTask } from "../../src/framework/runner.ts"
import type { AgentAdapter, AdapterConfig, RunResult, Task } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"

/** Mock adapter that writes a file and returns */
function createMockAdapter(writeContent?: Record<string, string>): AgentAdapter {
  return {
    name: "mock",
    async setup(_config: AdapterConfig) {},
    async run(task: { prompt: string; workDir: string }): Promise<RunResult> {
      // Write specified files to the workdir
      if (writeContent) {
        for (const [name, content] of Object.entries(writeContent)) {
          await Bun.write(`${task.workDir}/${name}`, content)
        }
      }
      return {
        text: "Done",
        steps: [{
          role: "assistant",
          text: "I completed the task",
          toolCalls: [],
          timestamp: Date.now(),
        }],
        tokens: emptyTokenUsage(),
        cost: 0,
        durationMs: 100,
        llmDurationMs: 0,
        workDir: task.workDir,
        runStatus: "ok",
      }
    },
    async teardown() {},
  }
}

describe("runTask", () => {
  test("runs task and evaluates successfully", async () => {
    const task: Task = {
      id: "count-lines",
      prompt: "Count lines in data.txt, write count to result.txt",
      fixtures: { "data.txt": "a\nb\nc\nd\ne" },
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "5" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter = createMockAdapter({ "result.txt": "5" })
    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(true)
    expect(result.overallScore).toBe(1.0)
    expect(result.evalResults).toHaveLength(1)
    expect(result.evalResults[0]!.pass).toBe(true)
    expect(result.task.id).toBe("count-lines")
  })

  test("reports failure when eval fails", async () => {
    const task: Task = {
      id: "wrong-answer",
      prompt: "Write 42 to result.txt",
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "42" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter = createMockAdapter({ "result.txt": "43" })
    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(false)
    expect(result.overallScore).toBe(0.0)
  })

  test("handles multiple eval criteria", async () => {
    const task: Task = {
      id: "multi-eval",
      prompt: "Create two files",
      eval: [
        { method: "file-check", path: "a.txt", mode: "exact", expected: "hello" },
        { method: "file-check", path: "b.txt", mode: "exact", expected: "world" },
      ],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter = createMockAdapter({ "a.txt": "hello", "b.txt": "world" })
    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(true)
    expect(result.evalResults).toHaveLength(2)
    expect(result.evalResults[0]!.pass).toBe(true)
    expect(result.evalResults[1]!.pass).toBe(true)
  })

  test("partial pass: one criterion passes, one fails", async () => {
    const task: Task = {
      id: "partial",
      prompt: "Create files",
      eval: [
        { method: "file-check", path: "a.txt", mode: "exact", expected: "hello" },
        { method: "file-check", path: "b.txt", mode: "exact", expected: "wrong" },
      ],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter = createMockAdapter({ "a.txt": "hello", "b.txt": "right" })
    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(false)
    expect(result.overallScore).toBe(0.5) // 1/2 pass
  })

  test("fixtures are copied to workdir", async () => {
    let capturedWorkDir = ""
    const adapter: AgentAdapter = {
      name: "fixture-check",
      async setup() {},
      async run(task): Promise<RunResult> {
        capturedWorkDir = task.workDir
        // Verify fixture exists
        const content = await Bun.file(`${task.workDir}/input.csv`).text()
        // Write result based on fixture
        await Bun.write(`${task.workDir}/result.txt`, content.split("\n").length.toString())
        return {
          text: "Done",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 50,
          llmDurationMs: 0,
          workDir: task.workDir,
          runStatus: "ok",
        }
      },
      async teardown() {},
    }

    const task: Task = {
      id: "fixture-test",
      prompt: "Count CSV rows",
      fixtures: { "input.csv": "a,1\nb,2\nc,3" },
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "3" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(true)
  })

  test("skips eval and returns score=0 when adapter runStatus !== 'ok'", async () => {
    // Regression test for docs/skvm/bench-adapter-error-false-positive.md:
    // a timed-out adapter must not have its residual workDir scored by
    // the evaluator, even if the workDir happens to contain the expected
    // fixture files.
    const task: Task = {
      id: "timeout-false-positive",
      prompt: "Write '5' to result.txt",
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "5" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    // Mock adapter writes the exact file the evaluator would score as 1.0,
    // then reports runStatus=timeout. The runner should NOT call the evaluator
    // on this residual workDir.
    const adapter: AgentAdapter = {
      name: "mock-timeout",
      async setup() {},
      async run(task) {
        await Bun.write(`${task.workDir}/result.txt`, "5")
        return {
          text: "",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 300_004,
          llmDurationMs: 0,
          workDir: task.workDir,
          runStatus: "timeout",
          statusDetail: "mock subprocess killed after 300000ms",
        }
      },
      async teardown() {},
    }

    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallPass).toBe(false)
    expect(result.overallScore).toBe(0)
    expect(result.evalResults).toHaveLength(0)
    expect(result.runResult.runStatus).toBe("timeout")
  })

  test("parse-failed runs are also gated", async () => {
    const task: Task = {
      id: "parse-failed-gate",
      prompt: "irrelevant",
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "x" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter: AgentAdapter = {
      name: "mock-parse-failed",
      async setup() {},
      async run(task) {
        await Bun.write(`${task.workDir}/result.txt`, "x")
        return {
          text: "",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 10,
          llmDurationMs: 0,
          workDir: task.workDir,
          runStatus: "parse-failed",
        }
      },
      async teardown() {},
    }

    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    expect(result.overallScore).toBe(0)
    expect(result.evalResults).toHaveLength(0)
  })

  test("ok with reduced-telemetry statusDetail still gets evaluated", async () => {
    // Regression for round-3 Codex P1/P2: an adapter that ran cleanly but
    // could not extract structured telemetry (e.g. hermes sessions export
    // failed, jiuwenclaw history.json missing) should NOT be gated. The
    // runner gate must trigger ONLY on subprocess-level failure, not on
    // missing telemetry. Otherwise reduced-telemetry environments produce
    // forced-zero false negatives.
    const task: Task = {
      id: "reduced-telemetry-not-gated",
      prompt: "Write 'ok' to result.txt",
      eval: [{ method: "file-check", path: "result.txt", mode: "exact", expected: "ok" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter: AgentAdapter = {
      name: "mock-reduced-telemetry",
      async setup() {},
      async run(task) {
        // Simulate a clean-exit run with missing telemetry: tokens=0, but
        // the agent did finish and the workDir reflects real work.
        await Bun.write(`${task.workDir}/result.txt`, "ok")
        return {
          text: "",
          steps: [],
          tokens: emptyTokenUsage(),
          cost: 0,
          durationMs: 1234,
          llmDurationMs: 0,
          workDir: task.workDir,
          runStatus: "ok",
          statusDetail: "telemetry unavailable, workDir scored as-is",
        }
      },
      async teardown() {},
    }

    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    // Evaluator MUST run and score the workDir. The statusDetail is
    // metadata only; runStatus===ok is the gate criterion.
    expect(result.overallPass).toBe(true)
    expect(result.overallScore).toBe(1.0)
    expect(result.evalResults).toHaveLength(1)
    expect(result.runResult.runStatus).toBe("ok")
    expect(result.runResult.statusDetail).toContain("telemetry unavailable")
  })

  test("reporter output includes correct structure", async () => {
    const { saveResults, printSummary } = await import("../../src/framework/reporter.ts")

    const task: Task = {
      id: "reporter-test",
      prompt: "test",
      eval: [{ method: "file-check", path: "x.txt", mode: "exact", expected: "y" }],
      timeoutMs: 120_000,
      maxSteps: 30,
    }

    const adapter = createMockAdapter({ "x.txt": "y" })
    const result = await runTask({
      task,
      adapter,
      adapterConfig: { model: "test", maxSteps: 30, timeoutMs: 120_000 },
    })

    // Test that printSummary doesn't throw
    printSummary([result])

    // Test saveResults produces valid JSON
    const outPath = await saveResults([result], `test-${Date.now()}`)
    const saved = await Bun.file(outPath).json()
    expect(saved).toHaveLength(1)
    expect(saved[0].taskId).toBe("reporter-test")
    expect(saved[0].pass).toBe(true)
  })
})
