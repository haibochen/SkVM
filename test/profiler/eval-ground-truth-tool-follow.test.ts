/**
 * Ground-truth eval tests for all 7 tool-use and 5 instruction-following
 * primitives at L1.
 *
 * For tool-use primitives the agent creates files in workDir; we write those
 * files directly and run the eval. For text-only primitives (follow.*,
 * tool.call.format, tool.browser) the profiler writes response.txt.
 *
 * Uses the real framework evaluator which runs commands via sh -c. Some
 * generators use python3 -c "..." and others use python3 << 'PYEOF' heredoc
 * format; the evaluator handles both transparently.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { makeWorkDir, removeWorkDir, runEval, writeSetupFiles } from "../helpers/eval-ground-truth.ts"
import toolFileReadGen from "../../src/profiler/generators/tool-file-read.ts"
import toolFileWriteGen from "../../src/profiler/generators/tool-file-write.ts"
import toolExecGen from "../../src/profiler/generators/tool-exec.ts"
import toolCallFormatGen from "../../src/profiler/generators/tool-call-format.ts"
import toolCallBatchGen from "../../src/profiler/generators/tool-call-batch.ts"
import toolBrowserGen from "../../src/profiler/generators/tool-browser.ts"
import followFormatGen from "../../src/profiler/generators/follow-format.ts"
import followConstraintGen from "../../src/profiler/generators/follow-constraint.ts"
import followProcedureGen from "../../src/profiler/generators/follow-procedure.ts"
import followDelegationGen from "../../src/profiler/generators/follow-delegation.ts"
import followStyleGen from "../../src/profiler/generators/follow-style.ts"

let workDir: string

beforeEach(async () => {
  workDir = await makeWorkDir("tool-follow")
})
afterEach(async () => {
  await removeWorkDir(workDir)
})

// ===========================================================================
// TOOL-USE PRIMITIVES
// ===========================================================================

// ---------------------------------------------------------------------------
// tool.file.read L1
// Eval: checks result.txt matches data.txt content exactly (stripped).
// ---------------------------------------------------------------------------

describe("tool.file.read L1", () => {
  test("passes with matching result.txt", async () => {
    const inst = toolFileReadGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const dataContent = inst.setupFiles!["data.txt"]!
    await writeFile(path.join(workDir, "result.txt"), dataContent)

    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong result.txt", async () => {
    const inst = toolFileReadGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "result.txt"), "totally wrong content")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tool.file.write L1
// Eval: checks output.txt has exact content.
// The eval does: expected = json.loads('${contentJson}') where contentJson
// is a JSON-encoded string like '"alpha 123\nbeta 456"'.
// ---------------------------------------------------------------------------

describe("tool.file.write L1", () => {
  test("passes with correct output.txt", async () => {
    const inst = toolFileWriteGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract expected content from eval: json.loads("...") or json.loads('...')
    const jsonMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/json\.loads\((".*?")\)/s)
      : null
    expect(jsonMatch).not.toBeNull()
    const expectedContent: string = JSON.parse(JSON.parse(jsonMatch![1]!))

    await writeFile(path.join(workDir, "output.txt"), expectedContent)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong output.txt", async () => {
    const inst = toolFileWriteGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "output.txt"), "wrong content entirely")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tool.exec L1
// Eval: checks result.txt matches expected output from a command.
// The eval does: expected = json.loads("...").strip() or similar
// ---------------------------------------------------------------------------

describe("tool.exec L1", () => {
  test("passes with correct result.txt", async () => {
    const inst = toolExecGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Run the actual command described in the prompt to produce the correct result
    // The eval checks result.txt content against the expected output embedded in the eval command.
    // Extract expected from: expected = JSON.stringify(...).strip()  or similar patterns
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\.strip\(\)/)
        ?? inst.eval.command.match(/expected\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = JSON.parse(expectedMatch![1]!).trim()

    await writeFile(path.join(workDir, "result.txt"), expected)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong result.txt", async () => {
    const inst = toolExecGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "result.txt"), "completely_wrong_output")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tool.call.format L1
// Eval: reads response.txt, parses JSON, checks function name and arguments.
// expected = json.loads('${expectedJson}')
// ---------------------------------------------------------------------------

describe("tool.call.format L1", () => {
  test("passes with correct JSON function call", async () => {
    const inst = toolCallFormatGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract expected JSON from: expected = json.loads("...escaped JSON...")
    // The argument to json.loads is a double-quoted string; JSON.parse decodes it.
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*json\.loads\((".*?")\)/s)
      : null
    expect(expectedMatch).not.toBeNull()
    const expectedJson: string = JSON.parse(expectedMatch![1]!)

    await writeFile(path.join(workDir, "response.txt"), expectedJson)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong function name", async () => {
    const inst = toolCallFormatGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const wrongJson = JSON.stringify({
      function: "wrong_function",
      arguments: { foo: "bar" },
    })
    await writeFile(path.join(workDir, "response.txt"), wrongJson)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tool.call.batch L1
// Eval: checks result.txt = part1.txt + "\n" + part2.txt (stripped).
// ---------------------------------------------------------------------------

describe("tool.call.batch L1", () => {
  test("passes with correctly combined content", async () => {
    const inst = toolCallBatchGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const p1 = inst.setupFiles!["part1.txt"]!
    const p2 = inst.setupFiles!["part2.txt"]!
    const combined = p1 + "\n" + p2

    await writeFile(path.join(workDir, "result.txt"), combined)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with swapped content order", async () => {
    const inst = toolCallBatchGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const p1 = inst.setupFiles!["part1.txt"]!
    const p2 = inst.setupFiles!["part2.txt"]!
    const wrongCombined = p2 + "\n" + p1

    await writeFile(path.join(workDir, "result.txt"), wrongCombined)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tool.web L1 - SKIP (requires running a Bun HTTP server)
// ---------------------------------------------------------------------------

// TODO: tool.web L1 ground-truth test skipped -- requires starting a Bun HTTP
// server and performing live HTTP requests, making it too complex for a
// deterministic unit test.

// ---------------------------------------------------------------------------
// tool.browser L1
// Eval: checks result.txt matches the targetText extracted from an HTML file.
// expected = '${targetText}'
// ---------------------------------------------------------------------------

describe("tool.browser L1", () => {
  test("passes with correct extracted text", async () => {
    const inst = toolBrowserGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*'([^']+)'/)
      : null
    expect(expectedMatch).not.toBeNull()
    const expected = expectedMatch![1]!

    await writeFile(path.join(workDir, "result.txt"), expected)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong extracted text", async () => {
    const inst = toolBrowserGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(path.join(workDir, "result.txt"), "wrong_text_entirely")
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// INSTRUCTION-FOLLOWING PRIMITIVES
// ===========================================================================

// ---------------------------------------------------------------------------
// follow.format L1
// Eval: reads response.txt, parses JSON array, checks it has exactly K
// string items. K is embedded in the eval command.
// ---------------------------------------------------------------------------

describe("follow.format L1", () => {
  test("passes with valid JSON array of correct length", async () => {
    const inst = followFormatGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const kMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/len\(arr\)\s*[!=]=\s*(\d+)/)
      : null
    expect(kMatch).not.toBeNull()
    const K = parseInt(kMatch![1]!, 10)

    const arr = Array.from({ length: K }, (_, i) => `item_${i + 1}`)
    await writeFile(path.join(workDir, "response.txt"), JSON.stringify(arr))
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with wrong number of items", async () => {
    const inst = followFormatGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // K is always >= 4, so 1 item fails
    await writeFile(
      path.join(workDir, "response.txt"),
      JSON.stringify(["only_one"]),
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// follow.constraint L1
// Eval: reads response.txt, case-sensitive check for required word.
// word = '${item.word}'
// ---------------------------------------------------------------------------

describe("follow.constraint L1", () => {
  test("passes with response containing required word", async () => {
    const inst = followConstraintGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const wordMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/word\s*=\s*'([^']+)'/)
      : null
    expect(wordMatch).not.toBeNull()
    const word = wordMatch![1]!

    await writeFile(
      path.join(workDir, "response.txt"),
      `This is a paragraph that mentions ${word} in context.`,
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with response missing required word", async () => {
    const inst = followConstraintGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(
      path.join(workDir, "response.txt"),
      "This paragraph has no special words at all.",
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// follow.procedure L1
// Eval: reads response.txt, checks lines match ["START","1",...,"N","END"].
// expected = json.loads('${expectedJson}')
// ---------------------------------------------------------------------------

describe("follow.procedure L1", () => {
  test("passes with correct START/numbers/END sequence", async () => {
    const inst = followProcedureGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract expected lines from: expected = json.loads("...escaped...")
    // The argument to json.loads is a double-quoted string; JSON.parse
    // decodes the escape sequences, yielding the JSON array string, which
    // we parse again to get the actual array.
    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*json\.loads\((".*?")\)/s)
      : null
    expect(expectedMatch).not.toBeNull()
    const expectedLines: string[] = JSON.parse(JSON.parse(expectedMatch![1]!))

    await writeFile(
      path.join(workDir, "response.txt"),
      expectedLines.join("\n"),
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with missing END marker", async () => {
    const inst = followProcedureGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*json\.loads\((".*?")\)/s)
      : null
    expect(expectedMatch).not.toBeNull()
    const expectedLines: string[] = JSON.parse(JSON.parse(expectedMatch![1]!))
    const incomplete = expectedLines.slice(0, -1) // Drop END

    await writeFile(
      path.join(workDir, "response.txt"),
      incomplete.join("\n"),
    )
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// follow.delegation L1
// Eval: checks compute.py exists (len >= 10) and result.txt has expected
// product. expected = '${product}'
// ---------------------------------------------------------------------------

describe("follow.delegation L1", () => {
  test("passes with compute.py and correct result.txt", async () => {
    const inst = followDelegationGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*'(\d+)'/)
      : null
    expect(expectedMatch).not.toBeNull()
    const product = expectedMatch![1]!

    // Write a realistic compute.py (must be >= 10 chars)
    await writeFile(
      path.join(workDir, "compute.py"),
      `# compute product\nresult = ${product}\nwith open("result.txt", "w") as f:\n    f.write(str(result))\n`,
    )
    await writeFile(path.join(workDir, "result.txt"), product)

    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails when compute.py is missing", async () => {
    const inst = followDelegationGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const expectedMatch = inst.eval.method === "script"
      ? inst.eval.command.match(/expected\s*=\s*'(\d+)'/)
      : null
    expect(expectedMatch).not.toBeNull()
    const product = expectedMatch![1]!

    await writeFile(path.join(workDir, "result.txt"), product)

    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })

  test("fails with wrong result", async () => {
    const inst = followDelegationGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    await writeFile(
      path.join(workDir, "compute.py"),
      `# a real script that does something\nresult = 42\nprint(result)\n`,
    )
    await writeFile(path.join(workDir, "result.txt"), "0")

    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// follow.style L1
// Eval: reads response.txt, checks no contractions, no first-person
// pronouns, and 2-3 sentences.
// ---------------------------------------------------------------------------

describe("follow.style L1", () => {
  test("passes with formal academic text", async () => {
    const inst = followStyleGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const formal =
      "The phenomenon has been studied extensively by researchers across multiple disciplines. " +
      "Evidence suggests that further investigation would yield significant insights into the underlying mechanisms."
    await writeFile(path.join(workDir, "response.txt"), formal)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(true)
  })

  test("fails with contractions", async () => {
    const inst = followStyleGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const informal =
      "The phenomenon can't be ignored by scientists. " +
      "It's been studied for decades and still hasn't been fully understood."
    await writeFile(path.join(workDir, "response.txt"), informal)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })

  test("fails with first-person pronouns", async () => {
    const inst = followStyleGen.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    const firstPerson =
      "I have studied this phenomenon extensively in my research. " +
      "We believe that further investigation would yield significant results."
    await writeFile(path.join(workDir, "response.txt"), firstPerson)
    const result = await runEval(inst.eval, workDir)
    expect(result.pass).toBe(false)
  })
})
