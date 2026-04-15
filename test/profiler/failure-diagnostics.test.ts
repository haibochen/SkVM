import { test, expect, describe } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import type { AgentStep, RunResult } from "../../src/core/types.ts"
import { emptyTokenUsage } from "../../src/core/types.ts"
import {
  summarizeToolCalls,
  computeFileChanges,
  buildConsoleHint,
  buildFailureDiagnostics,
} from "../../src/profiler/failure-diagnostics.ts"

function makeRunResult(overrides: Partial<RunResult> & { steps: AgentStep[] }): RunResult {
  return {
    text: "",
    tokens: emptyTokenUsage(),
    cost: 0,
    durationMs: 10,
    llmDurationMs: 0,
    workDir: "/tmp/test",
    runStatus: "ok",
    ...overrides,
  }
}

describe("summarizeToolCalls", () => {
  test("empty steps", () => {
    const result = summarizeToolCalls([])
    expect(result.totalCalls).toBe(0)
    expect(result.byTool).toEqual({})
    expect(result.errors).toEqual([])
  })

  test("counts tools by name", () => {
    const steps: AgentStep[] = [
      {
        role: "assistant",
        toolCalls: [
          { id: "1", name: "write_file", input: { path: "a.py" } },
          { id: "2", name: "execute_command", input: { command: "python3 a.py" } },
        ],
        timestamp: 0,
      },
      {
        role: "tool",
        toolCalls: [
          { id: "3", name: "write_file", input: { path: "b.py" } },
        ],
        timestamp: 1,
      },
    ]
    const result = summarizeToolCalls(steps)
    expect(result.totalCalls).toBe(3)
    expect(result.byTool).toEqual({ write_file: 2, execute_command: 1 })
    expect(result.errors).toEqual([])
  })

  test("collects errors with non-zero exit codes", () => {
    const steps: AgentStep[] = [
      {
        role: "tool",
        toolCalls: [
          { id: "1", name: "execute_command", input: {}, exitCode: 0 },
          { id: "2", name: "execute_command", input: {}, exitCode: 1, output: "error msg" },
        ],
        timestamp: 0,
      },
    ]
    const result = summarizeToolCalls(steps)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.tool).toBe("execute_command")
    expect(result.errors[0]!.exitCode).toBe(1)
  })
})

describe("computeFileChanges", () => {
  let workDir: string

  test("detects created files", async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))
    await writeFile(path.join(workDir, "setup.txt"), "original")
    await writeFile(path.join(workDir, "new-file.py"), "print('hi')")
    await writeFile(path.join(workDir, "response.txt"), "ignored")

    const result = await computeFileChanges(workDir, { "setup.txt": "original" })
    expect(result.created).toEqual(["new-file.py"])
    expect(result.modified).toEqual([])
    expect(result.deleted).toEqual([])

    await rm(workDir, { recursive: true, force: true })
  })

  test("detects modified files", async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))
    await writeFile(path.join(workDir, "data.csv"), "changed content")

    const result = await computeFileChanges(workDir, { "data.csv": "original content" })
    expect(result.created).toEqual([])
    expect(result.modified).toEqual(["data.csv"])

    await rm(workDir, { recursive: true, force: true })
  })

  test("detects deleted files", async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))

    const result = await computeFileChanges(workDir, { "input.txt": "data" })
    expect(result.deleted).toEqual(["input.txt"])

    await rm(workDir, { recursive: true, force: true })
  })

  test("handles no setupFiles", async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))
    await writeFile(path.join(workDir, "output.py"), "code")
    await writeFile(path.join(workDir, "response.txt"), "text")

    const result = await computeFileChanges(workDir, undefined)
    expect(result.created).toEqual(["output.py"])
    expect(result.modified).toEqual([])
    expect(result.deleted).toEqual([])

    await rm(workDir, { recursive: true, force: true })
  })
})

describe("buildConsoleHint", () => {
  test("shows error when tool calls have errors", () => {
    const summary = {
      totalCalls: 3,
      byTool: { write_file: 1, execute_command: 2 },
      errors: [{ step: 1, tool: "execute_command", exitCode: 1 }],
    }
    const hint = buildConsoleHint(summary, { created: [], modified: [], deleted: [] })
    expect(hint).toContain("error: execute_command exit=1")
  })

  test("shows write/file count when no errors", () => {
    const summary = {
      totalCalls: 2,
      byTool: { write_file: 1, read_file: 1 },
      errors: [],
    }
    const hint = buildConsoleHint(summary, { created: ["foo.py"], modified: [], deleted: [] })
    expect(hint).toBe("(2 calls, 1 writes, 1 files created)")
  })

  test("shows zero writes when agent didn't write files", () => {
    const summary = { totalCalls: 0, byTool: {}, errors: [] }
    const hint = buildConsoleHint(summary, { created: [], modified: [], deleted: [] })
    expect(hint).toBe("(0 calls, 0 writes, 0 files created)")
  })

  test("shows adapter error when 0 steps", () => {
    const summary = { totalCalls: 0, byTool: {}, errors: [] }
    const hint = buildConsoleHint(
      summary,
      { created: [], modified: [], deleted: [] },
      { exitCode: 1, stderr: "timeout" },
      0,
    )
    expect(hint).toBe("(0 steps, adapter exit=1)")
  })

  test("shows no response when 0 steps without adapter error", () => {
    const summary = { totalCalls: 0, byTool: {}, errors: [] }
    const hint = buildConsoleHint(
      summary,
      { created: [], modified: [], deleted: [] },
      undefined,
      0,
    )
    expect(hint).toBe("(0 steps, no response)")
  })
})

describe("buildFailureDiagnostics", () => {
  test("produces all output fields with steps", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))
    await writeFile(path.join(workDir, "sales.csv"), "data")
    await writeFile(path.join(workDir, "response.txt"), "code in text")

    const steps: AgentStep[] = [
      { role: "assistant", text: "I will write the code", toolCalls: [], timestamp: 0 },
    ]

    const result = await buildFailureDiagnostics({
      runResult: makeRunResult({ steps, text: "I will write the code", workDir }),
      evalDetails: "Exit code: 1 (expected 0)",
      setupFiles: { "sales.csv": "data" },
      primitiveId: "gen.code.python",
      level: "L3",
      instanceIndex: 0,
      workDir,
      durationMs: 5000,
    })

    expect(result.consoleHint).toContain("0 calls")
    expect(result.logBlock).toContain("Failure diagnostics")
    expect(result.logBlock).toContain("gen.code.python")
    expect(result.report.primitiveId).toBe("gen.code.python")
    expect(result.report.agentText).toBe("I will write the code")
    expect(result.report.adapterError).toBeUndefined()
    expect(result.enrichedDetails).toContain("1 steps")

    await rm(workDir, { recursive: true, force: true })
  })

  test("reports adapter error and 0 steps", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))

    const result = await buildFailureDiagnostics({
      runResult: makeRunResult({
        steps: [],
        text: "",
        workDir,
        adapterError: { exitCode: 1, stderr: "connection refused" },
      }),
      evalDetails: "Exit code: 1 (expected 0)",
      primitiveId: "gen.code.python",
      level: "L2",
      instanceIndex: 2,
      workDir,
      durationMs: 3000,
    })

    expect(result.consoleHint).toBe("(0 steps, adapter exit=1)")
    expect(result.logBlock).toContain("Adapter error: exit=1")
    expect(result.logBlock).toContain("connection refused")
    expect(result.logBlock).toContain("0 steps")
    expect(result.report.adapterError?.exitCode).toBe(1)
    expect(result.report.adapterError?.stderr).toBe("connection refused")
    expect(result.enrichedDetails).toContain("adapter exit=1")

    await rm(workDir, { recursive: true, force: true })
  })

  test("reports 0 steps without adapter error", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "fd-test-"))

    const result = await buildFailureDiagnostics({
      runResult: makeRunResult({ steps: [], text: "", workDir }),
      evalDetails: "FileNotFoundError: result.json",
      primitiveId: "gen.code.python",
      level: "L2",
      instanceIndex: 0,
      workDir,
      durationMs: 1000,
    })

    expect(result.consoleHint).toBe("(0 steps, no response)")
    expect(result.logBlock).toContain("0 steps (no conversation recorded)")
    expect(result.logBlock).not.toContain("Adapter error")

    await rm(workDir, { recursive: true, force: true })
  })
})
