import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildTaskGenPrompt,
  loadGeneratedTasks,
} from "../../src/jit-optimize/task-source.ts"

// ---------------------------------------------------------------------------
// buildTaskGenPrompt
// ---------------------------------------------------------------------------

describe("buildTaskGenPrompt", () => {
  test("renders protocol with count substituted and no diversity block when priorPrompts is empty", () => {
    const prompt = buildTaskGenPrompt(5, [])
    // Count substituted
    expect(prompt).toContain("produce **5 self-contained evaluation tasks**")
    expect(prompt).toContain("0 .. 4")
    // Diversity block is the empty-state sentence
    expect(prompt).toContain("No prior prompts this session")
    expect(prompt).not.toContain("Do NOT produce a task similar")
    // Retry preamble absent by default
    expect(prompt).not.toContain("**RETRY**")
  })

  test("embeds every prior prompt and the do-not instruction when priorPrompts is non-empty", () => {
    const priors = [
      "Extract the invoice numbers from receipt.pdf",
      "Summarize page 3 of the annual report",
      "Convert contract.pdf to markdown",
    ]
    const prompt = buildTaskGenPrompt(3, priors)
    expect(prompt).toContain("Do NOT produce a task similar")
    for (const p of priors) {
      expect(prompt).toContain(p)
    }
    expect(prompt).toContain("1. Extract the invoice numbers from receipt.pdf")
    expect(prompt).toContain("2. Summarize page 3 of the annual report")
    expect(prompt).toContain("3. Convert contract.pdf to markdown")
  })

  test("prepends RETRY preamble when stern=true", () => {
    const prompt = buildTaskGenPrompt(1, [], true)
    expect(prompt.startsWith("**RETRY**")).toBe(true)
    expect(prompt).toContain("Read the protocol end-to-end")
  })
})

// ---------------------------------------------------------------------------
// loadGeneratedTasks — validation + allowlist
// ---------------------------------------------------------------------------

let tmpRoot: string

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "taskgen-test-"))
})

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

/**
 * Write a minimal `task-<k>/` directory tree inside `tasksOutDir`. Each
 * fixture in the fixtures map becomes a file under `fixtures/<path>`.
 */
async function writeTaskDir(
  tasksOutDir: string,
  taskId: string,
  taskJson: Record<string, unknown>,
  fixtures: Record<string, string> = {},
  extras: Record<string, string> = {},
): Promise<void> {
  const taskDir = path.join(tasksOutDir, taskId)
  await mkdir(taskDir, { recursive: true })
  await writeFile(path.join(taskDir, "task.json"), JSON.stringify(taskJson, null, 2))
  for (const [rel, content] of Object.entries(fixtures)) {
    const full = path.join(taskDir, "fixtures", rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  for (const [rel, content] of Object.entries(extras)) {
    const full = path.join(taskDir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

async function freshTasksOutDir(label: string): Promise<string> {
  const dir = path.join(tmpRoot, label)
  await mkdir(dir, { recursive: true })
  return dir
}

describe("loadGeneratedTasks", () => {
  test("empty tasks-out directory returns empty list", async () => {
    const dir = await freshTasksOutDir("empty")
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toEqual([])
  })

  test("accepts a valid llm-judge task with no fixtures", async () => {
    const dir = await freshTasksOutDir("ok-llm-judge")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Simple judge",
      prompt: "Write a short summary.",
      eval: [
        {
          method: "llm-judge",
          id: "q",
          name: "Quality",
          rubric: "1.0 = correct, 0 = wrong",
          maxScore: 1,
          weight: 1.0,
        },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(dropped).toEqual([])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe("task-0")
    expect(tasks[0]!.prompt).toBe("Write a short summary.")
    expect(tasks[0]!.fixturesDir).toBeUndefined()
  })

  test("accepts a valid file-check task with a fixture and points fixturesDir at the task's fixtures dir", async () => {
    const dir = await freshTasksOutDir("ok-file-check")
    await writeTaskDir(
      dir,
      "task-0",
      {
        id: "task-0",
        name: "Summary file",
        prompt: "Summarize data.txt to summary.txt",
        eval: [
          {
            method: "file-check",
            id: "out",
            name: "summary.txt contains topic",
            path: "summary.txt",
            mode: "contains",
            expected: "topic",
            weight: 1.0,
          },
        ],
      },
      { "data.txt": "topic: cats. body: meow." },
    )
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(dropped).toEqual([])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.fixturesDir).toBe(path.join(dir, "task-0", "fixtures"))
  })

  test("drops task whose id does not match its directory name", async () => {
    const dir = await freshTasksOutDir("id-mismatch")
    await writeTaskDir(dir, "task-0", {
      id: "something-else",
      name: "Bad id",
      prompt: "x",
      eval: [
        { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("id")
  })

  test("drops task with method=script (outside allowlist)", async () => {
    const dir = await freshTasksOutDir("script-disallowed")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Script-based",
      prompt: "x",
      eval: [
        {
          method: "script",
          id: "s",
          name: "exit 0",
          command: "true",
          weight: 1.0,
        },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("script")
  })

  test("drops custom task with evaluatorId outside the allowlist", async () => {
    const dir = await freshTasksOutDir("custom-disallowed")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Unknown custom",
      prompt: "x",
      eval: [
        {
          method: "custom",
          evaluatorId: "not-a-real-evaluator",
          id: "c",
          name: "c",
          weight: 1.0,
          payload: null,
        },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("not-a-real-evaluator")
  })

  test("drops task when fixtures exceed file-count cap", async () => {
    const dir = await freshTasksOutDir("too-many-fixtures")
    const fixtures: Record<string, string> = {}
    for (let i = 0; i < 25; i++) fixtures[`f${i}.txt`] = "x"
    await writeTaskDir(
      dir,
      "task-0",
      {
        id: "task-0",
        name: "big",
        prompt: "x",
        eval: [
          { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
        ],
      },
      fixtures,
    )
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("fixture files")
  })

  test("drops task when a single fixture exceeds per-file byte cap", async () => {
    const dir = await freshTasksOutDir("huge-fixture")
    const bigContent = "x".repeat(64 * 1024 + 1)
    await writeTaskDir(
      dir,
      "task-0",
      {
        id: "task-0",
        name: "big file",
        prompt: "x",
        eval: [
          { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
        ],
      },
      { "huge.txt": bigContent },
    )
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("per-file cap")
  })

  test("drops task with no eval criteria", async () => {
    const dir = await freshTasksOutDir("no-eval")
    // BenchTaskFileSchema enforces eval.min(1), so it fails at the load layer,
    // not inside checkEvalAllowlist — dropped with an unparseable message.
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "empty eval",
      prompt: "x",
      eval: [],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
  })

  test("accepts python-grade custom task when grade.py is present alongside task.json", async () => {
    const dir = await freshTasksOutDir("ok-python-grade")
    await writeTaskDir(
      dir,
      "task-0",
      {
        id: "task-0",
        name: "Graded",
        prompt: "Produce output.json",
        eval: [
          {
            method: "custom",
            evaluatorId: "python-grade",
            id: "grade",
            name: "Auto Grade",
            weight: 1.0,
          },
        ],
      },
      {},
      {
        "grade.py": `def grade(transcript, workspace_path):
    return [{"id": "ok", "score": 1.0, "weight": 1.0, "description": "placeholder"}]
`,
      },
    )
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(dropped).toEqual([])
    expect(tasks).toHaveLength(1)
    // grade.py source should have been hydrated into the criterion's payload
    // by hydrateEvalPayloads via loadTaskFromPath → python-grade.loadPayload.
    const crit = tasks[0]!.eval[0]! as { method: string; payload?: unknown }
    expect(crit.method).toBe("custom")
    expect(typeof crit.payload).toBe("string")
    expect(crit.payload as string).toContain("def grade(")
  })

  test("handles multiple tasks in numeric order", async () => {
    const dir = await freshTasksOutDir("multi")
    const baseEval = [
      { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
    ]
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "a",
      prompt: "prompt 0",
      eval: baseEval,
    })
    await writeTaskDir(dir, "task-2", {
      id: "task-2",
      name: "c",
      prompt: "prompt 2",
      eval: baseEval,
    })
    await writeTaskDir(dir, "task-1", {
      id: "task-1",
      name: "b",
      prompt: "prompt 1",
      eval: baseEval,
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(dropped).toEqual([])
    expect(tasks.map((t) => t.id)).toEqual(["task-0", "task-1", "task-2"])
  })

  test("caps returned tasks at requested count; surplus reported as dropped", async () => {
    const dir = await freshTasksOutDir("cap")
    const baseEval = [
      { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
    ]
    for (let i = 0; i < 5; i++) {
      await writeTaskDir(dir, `task-${i}`, {
        id: `task-${i}`,
        name: `task ${i}`,
        prompt: `prompt ${i}`,
        eval: baseEval,
      })
    }
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 3 })
    expect(tasks.map((t) => t.id)).toEqual(["task-0", "task-1", "task-2"])
    expect(dropped.map((d) => d.id)).toEqual(["task-3", "task-4"])
    for (const d of dropped) {
      expect(d.reason).toContain("exceeds requested count 3")
    }
  })

  test("drops python-grade task when grade.py is missing", async () => {
    const dir = await freshTasksOutDir("python-grade-missing")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Graded",
      prompt: "Produce output.json",
      eval: [
        {
          method: "custom",
          evaluatorId: "python-grade",
          id: "grade",
          name: "Auto Grade",
          weight: 1.0,
        },
      ],
    })
    // No grade.py written alongside task.json.
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("python-grade")
    expect(dropped[0]!.reason).toContain("grade.py")
  })

  test("drops junit-grade task whose testFile is not found under fixtures/", async () => {
    const dir = await freshTasksOutDir("junit-missing-testfile")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Junit graded",
      prompt: "Produce output",
      eval: [
        {
          method: "custom",
          evaluatorId: "junit-grade",
          id: "tests",
          name: "Tests",
          weight: 1.0,
          payload: {
            testFile: "nonexistent.test.ts",
            criteria: [
              {
                id: "c0",
                weight: 1.0,
                description: "placeholder",
                testPattern: "anything",
              },
            ],
          },
        },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("junit-grade")
    expect(dropped[0]!.reason).toContain("nonexistent.test.ts")
  })

  test("drops junit-grade task with absolute testFile", async () => {
    const dir = await freshTasksOutDir("junit-abs-testfile")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "Junit abs",
      prompt: "x",
      eval: [
        {
          method: "custom",
          evaluatorId: "junit-grade",
          id: "tests",
          name: "Tests",
          weight: 1.0,
          payload: {
            testFile: "/etc/passwd",
            criteria: [
              {
                id: "c0",
                weight: 1.0,
                description: "placeholder",
                testPattern: "anything",
              },
            ],
          },
        },
      ],
    })
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(tasks).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.reason).toContain("relative path")
  })

  test("accepts junit-grade task when testFile exists under fixtures/", async () => {
    const dir = await freshTasksOutDir("junit-ok")
    await writeTaskDir(
      dir,
      "task-0",
      {
        id: "task-0",
        name: "Junit ok",
        prompt: "x",
        eval: [
          {
            method: "custom",
            evaluatorId: "junit-grade",
            id: "tests",
            name: "Tests",
            weight: 1.0,
            payload: {
              testFile: "my.test.ts",
              criteria: [
                {
                  id: "c0",
                  weight: 1.0,
                  description: "placeholder",
                  testPattern: "anything",
                },
              ],
            },
          },
        ],
      },
      { "my.test.ts": 'import { test } from "bun:test"; test("noop", () => {});\n' },
    )
    const { tasks, dropped } = await loadGeneratedTasks(dir, { count: 10 })
    expect(dropped).toEqual([])
    expect(tasks).toHaveLength(1)
  })

  test("applies the synthetic timeoutMs default when task.json omits it", async () => {
    const dir = await freshTasksOutDir("default-timeout")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "no timeout",
      prompt: "x",
      // No timeoutMs, no maxSteps fields at all.
      eval: [
        { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
      ],
    })
    const { tasks } = await loadGeneratedTasks(dir, {
      count: 10,
      timeoutMs: 999_999,
      maxSteps: 77,
    })
    expect(tasks).toHaveLength(1)
    // The caller-supplied defaults must reach the RunnableTask — they would
    // silently be shadowed if the schema eagerly defaulted missing fields.
    expect(tasks[0]!.timeoutMs).toBe(999_999)
    expect(tasks[0]!.maxSteps).toBe(77)
  })

  test("honors task-level timeoutMs / maxSteps when specified", async () => {
    const dir = await freshTasksOutDir("explicit-timeout")
    await writeTaskDir(dir, "task-0", {
      id: "task-0",
      name: "explicit",
      prompt: "x",
      timeoutMs: 12345,
      maxSteps: 7,
      eval: [
        { method: "llm-judge", id: "j", name: "j", rubric: "r", maxScore: 1, weight: 1 },
      ],
    })
    const { tasks } = await loadGeneratedTasks(dir, {
      count: 10,
      timeoutMs: 999_999,
      maxSteps: 77,
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.timeoutMs).toBe(12345)
    expect(tasks[0]!.maxSteps).toBe(7)
  })
})
