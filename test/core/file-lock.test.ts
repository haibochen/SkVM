import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import os from "node:os"
import {
  tryAcquireFileLock,
  acquireFileLock,
  releaseFileLock,
  withFileLock,
  __heldLocksForTest,
  __simulateProcessExitForTest,
} from "../../src/core/file-lock.ts"

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "file-lock-test-"))
})

afterEach(() => {
  // Release anything still held so tests don't leak locks into each other
  for (const file of [...__heldLocksForTest()]) releaseFileLock(file)
  rmSync(workDir, { recursive: true, force: true })
})

describe("tryAcquireFileLock", () => {
  test("first caller wins, second caller fails until released", () => {
    const file = path.join(workDir, "a.lock")
    expect(tryAcquireFileLock(file)).toBe(true)
    expect(tryAcquireFileLock(file)).toBe(false)
    releaseFileLock(file)
    expect(tryAcquireFileLock(file)).toBe(true)
  })

  test("releaseFileLock is idempotent and ignores foreign paths", () => {
    const file = path.join(workDir, "b.lock")
    releaseFileLock(file)          // not held → no-op
    expect(tryAcquireFileLock(file)).toBe(true)
    releaseFileLock(file)
    releaseFileLock(file)          // second release → no-op
    expect(existsSync(file)).toBe(false)
  })

  test("reaps lock files whose local pid is gone", () => {
    const file = path.join(workDir, "c.lock")
    // Impersonate a dead holder: PID 2^31 - 1 is not plausibly running,
    // and marking our own hostname means the primitive uses kill(pid, 0).
    writeFileSync(
      file,
      JSON.stringify({ pid: 2147483646, host: os.hostname(), ts: new Date().toISOString() }),
    )
    expect(tryAcquireFileLock(file)).toBe(true)
    // Payload should now belong to us.
    const raw = JSON.parse(require("node:fs").readFileSync(file, "utf8"))
    expect(raw.pid).toBe(process.pid)
    expect(raw.host).toBe(os.hostname())
  })

  test("respects live pid on our host", () => {
    const file = path.join(workDir, "d.lock")
    // Our own pid is definitely alive.
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }),
    )
    expect(tryAcquireFileLock(file)).toBe(false)
  })

  test("applies mtime TTL even when same-host pid is alive (PID reuse defense)", () => {
    const file = path.join(workDir, "reuse.lock")
    // Write a payload claiming our own (definitely alive) pid, then backdate
    // the file past the staleMs ceiling. This models a crash where the
    // original holder's pid was later reused by an unrelated process.
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }),
    )
    const past = new Date(Date.now() - 5 * 60 * 1000)
    require("node:fs").utimesSync(file, past, past)
    expect(tryAcquireFileLock(file, { staleMs: 60_000 })).toBe(true)
  })

  test("propagates filesystem errors instead of misreporting as contention", () => {
    // Parent directory doesn't exist → openSync fails with ENOENT.
    // Must surface the real error, not return false (which callers
    // would misinterpret as "another holder has the lock").
    const file = path.join(workDir, "does-not-exist", "f.lock")
    expect(() => tryAcquireFileLock(file)).toThrow(/ENOENT/)
  })

  test("falls back to mtime TTL when host is unknown", () => {
    const file = path.join(workDir, "e.lock")
    writeFileSync(
      file,
      JSON.stringify({ pid: 99999, host: "some-other-host", ts: new Date().toISOString() }),
    )
    // Fresh lock from another host, tight TTL → still held.
    expect(tryAcquireFileLock(file, { staleMs: 60_000 })).toBe(false)
    // Pretend it's old by moving mtime backward.
    const fsMod = require("node:fs")
    const past = new Date(Date.now() - 5 * 60 * 1000)
    fsMod.utimesSync(file, past, past)
    expect(tryAcquireFileLock(file, { staleMs: 60_000 })).toBe(true)
  })
})

describe("acquireFileLock (blocking)", () => {
  test("throws on timeout when lock is held by someone alive", async () => {
    const file = path.join(workDir, "block.lock")
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString() }),
    )
    await expect(acquireFileLock(file, { timeoutMs: 100 })).rejects.toThrow(/Timed out/)
  })

  test("succeeds once the lock is released", async () => {
    const file = path.join(workDir, "wait.lock")
    expect(tryAcquireFileLock(file)).toBe(true)

    const release = new Promise<void>((r) => setTimeout(() => { releaseFileLock(file); r() }, 80))
    await Promise.all([
      acquireFileLock(file, { timeoutMs: 1000, initialPollMs: 20 }),
      release,
    ])
    expect(__heldLocksForTest().has(file)).toBe(true)
  })
})

describe("ownership verification on release", () => {
  test("releaseFileLock leaves a lock alone if its contents have changed", () => {
    const file = path.join(workDir, "ownership.lock")
    expect(tryAcquireFileLock(file)).toBe(true)

    // Simulate the race Codex warned about: while we were stalled, another
    // process reaped our lock (because we looked stale) and wrote its own
    // payload. releaseFileLock must NOT delete the new owner's file.
    const impostor = JSON.stringify({ pid: 424242, host: os.hostname(), ts: "9999-01-01T00:00:00.000Z" })
    writeFileSync(file, impostor)

    releaseFileLock(file)
    expect(existsSync(file)).toBe(true)
    expect(require("node:fs").readFileSync(file, "utf8")).toBe(impostor)

    // heldLocks should still be cleaned up even though we didn't delete the file.
    expect(__heldLocksForTest().has(file)).toBe(false)
  })
})

describe("withFileLock", () => {
  test("releases lock on success and on throw", async () => {
    const file = path.join(workDir, "with.lock")

    await withFileLock(file, { timeoutMs: 500 }, async () => {
      expect(__heldLocksForTest().has(file)).toBe(true)
    })
    expect(__heldLocksForTest().has(file)).toBe(false)
    expect(existsSync(file)).toBe(false)

    await expect(
      withFileLock(file, { timeoutMs: 500 }, async () => { throw new Error("boom") }),
    ).rejects.toThrow("boom")
    expect(__heldLocksForTest().has(file)).toBe(false)
    expect(existsSync(file)).toBe(false)
  })
})

describe("heartbeat", () => {
  test("refreshes mtime while held so stale ceiling can't reap a live holder", async () => {
    const file = path.join(workDir, "heart.lock")
    // Acquire with a very short heartbeat and a very short stale ceiling.
    // Without heartbeat, the lock would be reapable after 150ms; with
    // heartbeat every 40ms, mtime stays fresh and the lock survives.
    expect(tryAcquireFileLock(file, { staleMs: 150, heartbeatMs: 40 })).toBe(true)
    const mtime0 = statSync(file).mtimeMs
    await Bun.sleep(250)
    const mtime1 = statSync(file).mtimeMs
    expect(mtime1).toBeGreaterThan(mtime0)

    // Another process's try-acquire should still see the lock as fresh.
    expect(tryAcquireFileLock(file, { staleMs: 150 })).toBe(false)
    releaseFileLock(file)
  }, 5000)

  test("stops refreshing if ownership is transferred to another holder", async () => {
    const file = path.join(workDir, "heart-transfer.lock")
    expect(tryAcquireFileLock(file, { staleMs: 60_000, heartbeatMs: 20 })).toBe(true)

    // Overwrite the file with an impostor payload — simulating another
    // process having reaped and reacquired while we were stalled.
    const impostor = JSON.stringify({ pid: 1234, host: os.hostname(), ts: "9999-01-01T00:00:00.000Z" })
    writeFileSync(file, impostor)

    // Wait long enough for several heartbeat ticks to fire and notice the mismatch.
    await Bun.sleep(120)

    // Contents must still be the impostor — heartbeat must NOT have touched
    // the file or written our own payload over theirs.
    expect(require("node:fs").readFileSync(file, "utf8")).toBe(impostor)

    // And releaseFileLock is still safe — it's a no-op on the impostor.
    releaseFileLock(file)
    expect(existsSync(file)).toBe(true)
    expect(require("node:fs").readFileSync(file, "utf8")).toBe(impostor)
  }, 5000)

  test("release stops the heartbeat cleanly", async () => {
    const file = path.join(workDir, "heart-stop.lock")
    expect(tryAcquireFileLock(file, { staleMs: 60_000, heartbeatMs: 20 })).toBe(true)
    releaseFileLock(file)
    expect(existsSync(file)).toBe(false)

    // Recreate the file at the same path; if the heartbeat timer were still
    // alive it would keep bumping this unrelated file's mtime.
    writeFileSync(file, "unrelated")
    const mtime0 = statSync(file).mtimeMs
    await Bun.sleep(120)
    const mtime1 = statSync(file).mtimeMs
    expect(mtime1).toBe(mtime0)
  }, 5000)
})

describe("releaseOnProcessExit opt-out", () => {
  test("process-wide cleanup skips locks marked releaseOnProcessExit: false", () => {
    const keepFile = path.join(workDir, "keep.lock")
    const dropFile = path.join(workDir, "drop.lock")

    expect(tryAcquireFileLock(keepFile, { releaseOnProcessExit: false })).toBe(true)
    expect(tryAcquireFileLock(dropFile)).toBe(true)

    __simulateProcessExitForTest()

    expect(existsSync(keepFile)).toBe(true)  // protected — subprocess might still be using it
    expect(existsSync(dropFile)).toBe(false) // default path — released

    // The opted-out lock is still in heldLocks, so explicit release still works.
    expect(__heldLocksForTest().has(keepFile)).toBe(true)
    releaseFileLock(keepFile)
    expect(existsSync(keepFile)).toBe(false)
  })
})

describe("crash cleanup via subprocess", () => {
  test("lock left by a killed process is reaped by the next acquirer", async () => {
    const file = path.join(workDir, "subproc.lock")

    // Spawn a child that acquires the lock and then sleeps forever.
    const childSrc = `
      import { tryAcquireFileLock } from "${path.resolve(import.meta.dir, "../../src/core/file-lock.ts")}"
      const ok = tryAcquireFileLock(${JSON.stringify(file)})
      console.log(ok ? "acquired" : "failed")
      await new Promise(() => {})
    `
    const childFile = path.join(workDir, "child.ts")
    writeFileSync(childFile, childSrc)

    const child = Bun.spawn(["bun", "run", childFile], { stdout: "pipe" })
    // Wait for the child to confirm it holds the lock.
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let msg = ""
    while (!msg.includes("acquired")) {
      const { value, done } = await reader.read()
      if (done) break
      msg += decoder.decode(value)
    }
    expect(msg).toContain("acquired")
    expect(existsSync(file)).toBe(true)

    // SIGKILL — no cleanup handlers get to run, leaving a stale lock file.
    child.kill("SIGKILL")
    await child.exited

    // File is still present with the child's pid, but that pid is now gone.
    expect(existsSync(file)).toBe(true)
    // The next acquire should reap it and succeed.
    expect(tryAcquireFileLock(file)).toBe(true)
  }, 10_000)
})
