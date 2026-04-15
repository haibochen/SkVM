/**
 * Ground-truth eval tests for the 9 generation-primitive generators at L1.
 *
 * For each generator we:
 *   1. Call generator.generate("L1") to get a randomised instance.
 *   2. Prepare the workDir with setupFiles.
 *   3. Construct a known-correct answer (or known-incorrect for the failure path).
 *   4. Run the eval via the evaluator and assert pass / fail.
 *
 * Tool-use primitives (gen.code.*) need output files in workDir.
 * Text-only primitives (gen.text.*, gen.regex) need response.txt.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { evaluate } from "../../src/framework/evaluator.ts"
import { baseResult, makeWorkDir, removeWorkDir, writeSetupFiles } from "../helpers/eval-ground-truth.ts"

import genCodePython from "../../src/profiler/generators/gen-code-python.ts"
import genCodeJavascript from "../../src/profiler/generators/gen-code-javascript.ts"
import genCodeShell from "../../src/profiler/generators/gen-code-shell.ts"
import genCodeSql from "../../src/profiler/generators/gen-code-sql.ts"
import genCodeHtml from "../../src/profiler/generators/gen-code-html.ts"
import genTextStructured from "../../src/profiler/generators/gen-text-structured.ts"
import genTextLong from "../../src/profiler/generators/gen-text-long.ts"
import genTextProse from "../../src/profiler/generators/gen-text-prose.ts"
import genRegex from "../../src/profiler/generators/gen-regex.ts"

let workDir: string

beforeEach(async () => {
  workDir = await makeWorkDir("gen")
})

afterEach(async () => {
  await removeWorkDir(workDir)
})

// ===========================================================================
// gen.code.python  L1
// ===========================================================================
// Eval: `python3 *.py 2>/dev/null; cat result.txt`
// expectedOutput: String(expectedCount)
// We just write result.txt with the correct count.  python3 *.py will fail
// silently (no .py file) but cat result.txt still runs because of `;`.

describe("gen.code.python L1 eval", () => {
  test("passes with correct result", async () => {
    const inst = genCodePython.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Compute correct answer from the generated data
    const inputLines = inst.setupFiles!["input.txt"]!.split("\n")
    const tMatch = inst.prompt.match(/number is >= (\d+)/)
    const T = parseInt(tMatch![1]!)
    const count = inputLines.filter((line) => {
      const parts = line.split(":")
      return parseInt(parts[1]!) >= T
    }).length

    // Create solution.py that produces correct result (eval checks for script existence)
    await writeFile(path.join(workDir, "solution.py"), `
with open('input.txt') as f:
    lines = f.read().strip().split('\\n')
count = sum(1 for l in lines if int(l.split(':')[1]) >= ${T})
with open('result.txt', 'w') as f:
    f.write(str(count))
`)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong result", async () => {
    const inst = genCodePython.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)
    // Create a script that writes wrong answer
    await writeFile(path.join(workDir, "solution.py"), `
with open('result.txt', 'w') as f:
    f.write('99999')
`)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.code.javascript  L1
// ===========================================================================
// Eval: `node *.js 2>/dev/null; cat result.txt`
// expectedOutput: String(expectedCount)
// Same pattern — write result.txt with the correct line count.

describe("gen.code.javascript L1 eval", () => {
  test("passes with correct result", async () => {
    const inst = genCodeJavascript.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract the target character from the prompt
    const cMatch = inst.prompt.match(/contain the character "(.)"/)
    const C = cMatch![1]!
    const inputLines = inst.setupFiles!["input.txt"]!.split("\n")
    const count = inputLines.filter((line) => line.includes(C)).length

    // Create solution.js that produces correct result
    await writeFile(path.join(workDir, "solution.js"), `
const fs = require('fs');
const lines = fs.readFileSync('input.txt', 'utf-8').trim().split('\\n');
const count = lines.filter(l => l.includes('${C}')).length;
fs.writeFileSync('result.txt', String(count));
`)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong result", async () => {
    const inst = genCodeJavascript.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)
    await writeFile(path.join(workDir, "solution.js"), `
require('fs').writeFileSync('result.txt', '99999');
`)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.code.shell  L1
// ===========================================================================
// Eval: `bash *.sh 2>/dev/null; cat result.txt`
// expectedOutput: String(expectedCount) — lines starting with PREFIX.

describe("gen.code.shell L1 eval", () => {
  test("passes with correct result", async () => {
    const inst = genCodeShell.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract the target prefix from the prompt
    const prefixMatch = inst.prompt.match(/start with "(\w+)"/)
    const PREFIX = prefixMatch![1]!
    const dataLines = inst.setupFiles!["data.txt"]!.split("\n")
    const count = dataLines.filter((line) => line.startsWith(PREFIX)).length

    await writeFile(path.join(workDir, "result.txt"), String(count))

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong result", async () => {
    const inst = genCodeShell.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)
    await writeFile(path.join(workDir, "result.txt"), "99999")

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.code.sql  L1
// ===========================================================================
// Eval: `sqlite3 test.db < setup.sql 2>/dev/null;
//        result=$(sqlite3 test.db < query.sql 2>/dev/null); echo "$result"`
// expectedOutput: String(expectedCount)
// We must write a valid query.sql that returns the correct count.

describe("gen.code.sql L1 eval", () => {
  test("passes with correct query", async () => {
    const inst = genCodeSql.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Extract threshold from the prompt
    const tMatch = inst.prompt.match(/score >= (\d+)/)
    const T = parseInt(tMatch![1]!)

    // Write the correct SQL query
    await writeFile(
      path.join(workDir, "query.sql"),
      `SELECT COUNT(*) FROM users WHERE score >= ${T};`,
    )

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong query", async () => {
    const inst = genCodeSql.generate("L1")
    await writeSetupFiles(workDir, inst.setupFiles)

    // Query that returns a deliberately wrong count
    await writeFile(
      path.join(workDir, "query.sql"),
      `SELECT 99999;`,
    )

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.code.html  L1
// ===========================================================================
// Eval: python3 HTML parser checking index.html for:
//   - h1 containing TITLE
//   - exactly K li items matching expected items
// We write a correct index.html.

describe("gen.code.html L1 eval", () => {
  test("passes with correct HTML", async () => {
    const inst = genCodeHtml.generate("L1")

    // Extract title and items from the prompt
    const titleMatch = inst.prompt.match(/h1 heading with the text "([^"]+)"/)
    const title = titleMatch![1]!

    const kMatch = inst.prompt.match(/exactly (\d+) list items/)
    const K = parseInt(kMatch![1]!)

    // Extract item names from the prompt — they appear as quoted strings after "li):"
    const itemsMatch = inst.prompt.match(/list items \(li\): (.+)\n/)
    const itemStr = itemsMatch![1]!
    const items = itemStr.match(/"([^"]+)"/g)!.map((s) => s.replace(/"/g, ""))

    // Build valid HTML
    const liItems = items.map((it) => `<li>${it}</li>`).join("\n    ")
    const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <ul>
    ${liItems}
  </ul>
</body>
</html>`

    await writeFile(path.join(workDir, "index.html"), html)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong HTML", async () => {
    const inst = genCodeHtml.generate("L1")

    // Write HTML with wrong title and no list items
    const html = `<!DOCTYPE html>
<html>
<head><title>Wrong</title></head>
<body>
  <h1>Completely Wrong Title</h1>
  <ul></ul>
</body>
</html>`

    await writeFile(path.join(workDir, "index.html"), html)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.text.structured  L1
// ===========================================================================
// Eval: python3 reads response.txt, parses JSON, checks exact field values:
//   name, age, city, active, favorite_color.
// We extract the expected values from the prompt and write correct JSON.

describe("gen.text.structured L1 eval", () => {
  test("passes with correct JSON", async () => {
    const inst = genTextStructured.generate("L1")

    // Parse expected values from the prompt
    const nameMatch = inst.prompt.match(/"name": "([^"]+)"/)
    const ageMatch = inst.prompt.match(/"age": (\d+)/)
    const cityMatch = inst.prompt.match(/"city": "([^"]+)"/)
    const activeMatch = inst.prompt.match(/"active": (true|false)/)
    const colorMatch = inst.prompt.match(/"favorite_color": "([^"]+)"/)

    const json = JSON.stringify({
      name: nameMatch![1],
      age: parseInt(ageMatch![1]!),
      city: cityMatch![1],
      active: activeMatch![1] === "true",
      favorite_color: colorMatch![1],
    })

    await writeFile(path.join(workDir, "response.txt"), json)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong JSON", async () => {
    const inst = genTextStructured.generate("L1")

    const json = JSON.stringify({
      name: "WRONG",
      age: -1,
      city: "Nowhere",
      active: false,
      favorite_color: "invisible",
    })

    await writeFile(path.join(workDir, "response.txt"), json)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.text.long  L1
// ===========================================================================
// Eval: python3 checks response.txt for:
//   - START marker present
//   - END marker present
//   - K numbered items (regex: ^\s*\d+[.)]\s+)
//   - total bytes < 5120
// We extract START, END, K from the prompt and write correct text.

describe("gen.text.long L1 eval", () => {
  test("passes with correct long text", async () => {
    const inst = genTextLong.generate("L1")

    // Extract markers and count from the prompt
    const kMatch = inst.prompt.match(/exactly (\d+) key concepts/)
    const K = parseInt(kMatch![1]!)

    const startMatch = inst.prompt.match(/Start with: (.+)/)
    const START = startMatch![1]!.trim()

    const endMatch = inst.prompt.match(/End with: (.+)/)
    const END = endMatch![1]!.trim()

    // Build a valid response with K numbered items
    const items = Array.from({ length: K }, (_, i) =>
      `${i + 1}. Concept number ${i + 1} is an important idea in this field.`,
    ).join("\n")

    const text = `${START}\n${items}\n${END}`
    await writeFile(path.join(workDir, "response.txt"), text)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with missing markers", async () => {
    const inst = genTextLong.generate("L1")

    // Write text without the required markers
    const text = "1. Something\n2. Something else\n"
    await writeFile(path.join(workDir, "response.txt"), text)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })

  test("fails with wrong item count", async () => {
    const inst = genTextLong.generate("L1")

    const startMatch = inst.prompt.match(/Start with: (.+)/)
    const START = startMatch![1]!.trim()
    const endMatch = inst.prompt.match(/End with: (.+)/)
    const END = endMatch![1]!.trim()

    // Only write 1 item — always fewer than the required K (5-10)
    const text = `${START}\n1. Only one item.\n${END}`
    await writeFile(path.join(workDir, "response.txt"), text)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.text.prose  L1
// ===========================================================================
// Eval: python3 checks response.txt for:
//   - >= S sentences (split on [.!?]+(\s|$))
//   - all keywords present (case-insensitive)
//   - length >= 100 chars
// We extract S and keywords from the prompt and write valid prose.

describe("gen.text.prose L1 eval", () => {
  test("passes with correct prose", async () => {
    const inst = genTextProse.generate("L1")

    // Extract sentence count and keywords
    const sMatch = inst.prompt.match(/at least (\d+) sentences/)
    const S = parseInt(sMatch![1]!)

    // Keywords are quoted strings after "include these keywords"
    const kwSection = inst.prompt.match(/keywords.*?: (.+)\.\s*$/m)
    const kwMatches = kwSection![1]!.match(/"([^"]+)"/g)!
    const keywords = kwMatches.map((s) => s.replace(/"/g, ""))

    // Build prose with enough sentences and all keywords
    // First sentence uses all the keywords
    const kwSentence = `This topic involves ${keywords.join(", ")} and many related ideas.`
    // Remaining sentences are filler
    const fillerSentences = Array.from({ length: S }, (_, i) =>
      `This is sentence number ${i + 2} discussing important aspects of the subject matter in depth.`,
    )
    const prose = [kwSentence, ...fillerSentences].join(" ")

    await writeFile(path.join(workDir, "response.txt"), prose)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with missing keywords", async () => {
    const inst = genTextProse.generate("L1")

    // Write enough sentences but without any of the required keywords
    const prose = Array.from({ length: 10 }, (_, i) =>
      `Sentence ${i + 1} talks about cats and dogs and other animals.`,
    ).join(" ")

    await writeFile(path.join(workDir, "response.txt"), prose)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })

  test("fails with too few sentences", async () => {
    const inst = genTextProse.generate("L1")

    // Single short sentence — will fail sentence count (needs 4-7)
    await writeFile(path.join(workDir, "response.txt"), "One short line.")

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})

// ===========================================================================
// gen.regex  L1
// ===========================================================================
// Eval: python3 reads response.txt as a regex pattern, applies it to test
// strings with expected match/no-match outcomes. The word W is extracted from
// the prompt.  The correct regex simply needs to match strings containing W.

describe("gen.regex L1 eval", () => {
  test("passes with correct regex", async () => {
    const inst = genRegex.generate("L1")

    // Extract the target word from the prompt
    const wMatch = inst.prompt.match(/containing the word "(\w+)"/)
    const W = wMatch![1]!

    // The simplest correct regex: the word itself as a substring pattern
    await writeFile(path.join(workDir, "response.txt"), W)

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(true)
  })

  test("fails with wrong regex", async () => {
    const inst = genRegex.generate("L1")

    // A regex that matches everything — will produce false positives
    await writeFile(path.join(workDir, "response.txt"), ".*")

    const result = await evaluate(inst.eval, { ...baseResult(workDir), workDir })
    expect(result.pass).toBe(false)
  })
})
