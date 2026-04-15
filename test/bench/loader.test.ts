import { describe, test, expect } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { loadTasks, writeTask } from "../../src/bench/loader.ts"
import type { BenchTask } from "../../src/bench/types.ts"

describe("Flat Task Loader", () => {
  test("loads a single task where dirname == task.id", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "bench-loader-test-"))

    const taskDir = path.join(testDir, "task_hello")
    await mkdir(taskDir, { recursive: true })
    await Bun.write(path.join(taskDir, "task.json"), JSON.stringify({
      id: "task_hello",
      name: "Hello Test",
      category: "basic",
      prompt: "Say hello",
      eval: [{ method: "file-check", path: "hello.txt", mode: "contains", expected: "hello" }],
      skill: null,
    }))

    const loaded = await loadTasks({ tasksDir: testDir })
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.id).toBe("task_hello")
    expect(loaded[0]!.taskDir).toBe(taskDir)

    await rm(testDir, { recursive: true, force: true })
  })

  test("loads multiple flat tasks", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "bench-loader-test-"))

    for (const id of ["task_a", "task_b"]) {
      const taskDir = path.join(testDir, id)
      await mkdir(taskDir, { recursive: true })
      await Bun.write(path.join(taskDir, "task.json"), JSON.stringify({
        id, prompt: "test", eval: [{ method: "file-check", path: "x", mode: "exact", expected: "y" }],
      }))
    }

    const loaded = await loadTasks({ tasksDir: testDir })
    expect(loaded.length).toBe(2)
    expect(loaded.find(t => t.id === "task_a")).toBeDefined()
    expect(loaded.find(t => t.id === "task_b")).toBeDefined()

    await rm(testDir, { recursive: true, force: true })
  })

  test("skips tasks where dirname does not match task.id", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "bench-loader-test-"))
    const taskDir = path.join(testDir, "dir_name")
    await mkdir(taskDir, { recursive: true })
    await Bun.write(path.join(taskDir, "task.json"), JSON.stringify({
      id: "different_id", prompt: "x",
      eval: [{ method: "file-check", path: "a", mode: "exact", expected: "b" }],
    }))

    const loaded = await loadTasks({ tasksDir: testDir })
    expect(loaded.length).toBe(0)

    await rm(testDir, { recursive: true, force: true })
  })

  test("loads companion grade.py onto the custom criterion's payload", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "bench-loader-test-"))
    const taskDir = path.join(testDir, "task_graded")
    await mkdir(taskDir, { recursive: true })

    await Bun.write(path.join(taskDir, "task.json"), JSON.stringify({
      id: "task_graded", prompt: "Write code",
      eval: [{ method: "custom", evaluatorId: "python-grade" }],
    }))
    await Bun.write(path.join(taskDir, "grade.py"),
      "def grade(transcript, workspace_path):\n    return [{'id':'c','score':1.0,'weight':1.0}]")

    const loaded = await loadTasks({ tasksDir: testDir })
    const criterion = loaded[0]!.eval[0]!
    expect(criterion.method).toBe("custom")
    if (criterion.method === "custom") {
      expect(typeof criterion.payload).toBe("string")
      expect(criterion.payload as string).toContain("def grade")
    }

    await rm(testDir, { recursive: true, force: true })
  })

  test("writeTask round-trips grade.py via savePayload", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "bench-write-test-"))
    const task: BenchTask = {
      id: "test_write", name: "Write Test", category: "test",
      gradingType: "automated", prompt: "Do something",
      eval: [{
        method: "custom",
        evaluatorId: "python-grade",
        payload: "def grade(t, w): return [{'id':'c','score':1.0,'weight':1.0}]",
      }],
      timeoutMs: 60_000, maxSteps: 10,
      skill: "../skills/writing",
    }

    const taskDir = await writeTask(task, { tasksDir: outDir })

    expect(taskDir).toBe(path.join(outDir, "test_write"))
    expect(await Bun.file(path.join(taskDir, "task.json")).exists()).toBe(true)
    // savePayload should have persisted the custom criterion's payload to grade.py
    expect(await Bun.file(path.join(taskDir, "grade.py")).exists()).toBe(true)
    // The serialized task.json should NOT contain the payload inline, since
    // writeTask stripped it after persistEvalPayloads persisted it to disk.
    const serialized = JSON.parse(await Bun.file(path.join(taskDir, "task.json")).text())
    expect(serialized.eval[0].payload).toBeUndefined()

    await rm(outDir, { recursive: true, force: true })
  })

  test("handles missing directory gracefully", async () => {
    const loaded = await loadTasks({ tasksDir: "/nonexistent/path" })
    expect(loaded).toEqual([])
  })
})
