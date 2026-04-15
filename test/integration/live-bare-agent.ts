#!/usr/bin/env bun
/**
 * Live integration test: runs real tasks through the bare agent with actual LLM calls.
 *
 * Usage: bun run test/integration/live-bare-agent.ts
 *
 * Requires OPENROUTER_API_KEY in .env
 * Estimated cost: ~$0.01-0.05
 */

import "../../src/core/env-bootstrap.ts"
import { BareAgentAdapter } from "../../src/adapters/bare-agent.ts"
import { OpenRouterProvider } from "../../src/providers/openrouter.ts"
import { runTask } from "../../src/framework/runner.ts"
import { printSummary, saveResults } from "../../src/framework/reporter.ts"
import type { Task, AdapterConfig } from "../../src/core/types.ts"
import { setLogLevel } from "../../src/core/logger.ts"

setLogLevel("info")

// ---------------------------------------------------------------------------
// Check API key
// ---------------------------------------------------------------------------
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("OPENROUTER_API_KEY not set. Copy from skill-bench/.env or set in environment.")
  process.exit(1)
}

// Use a cheap, fast model for integration tests
const MODEL = "qwen/qwen3-30b-a3b-instruct-2507"

// ---------------------------------------------------------------------------
// Test Tasks
// ---------------------------------------------------------------------------

const tasks: Task[] = [
  {
    id: "write-hello",
    name: "Write hello world to a file",
    prompt: "Write the text 'hello world' (exactly, nothing else) to a file called output.txt",
    eval: [
      { method: "file-check", path: "output.txt", mode: "exact", expected: "hello world" },
    ],
    timeoutMs: 60_000,
    maxSteps: 10,
  },
  {
    id: "count-lines",
    name: "Count lines in a file",
    prompt: "Count the number of lines in data.txt and write just the number to result.txt (nothing else, just the integer).",
    fixtures: {
      "data.txt": "alpha\nbeta\ngamma\ndelta\nepsilon",
    },
    eval: [
      { method: "file-check", path: "result.txt", mode: "exact", expected: "5" },
    ],
    timeoutMs: 60_000,
    maxSteps: 10,
  },
  {
    id: "execute-and-capture",
    name: "Execute a command and save output",
    prompt: "Run the command 'echo 42' and write its output (just the number, nothing else) to result.txt.",
    eval: [
      { method: "file-check", path: "result.txt", mode: "exact", expected: "42" },
    ],
    timeoutMs: 60_000,
    maxSteps: 10,
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`\n=== SkVM Live Integration Test ===`)
console.log(`Model: ${MODEL}`)
console.log(`Tasks: ${tasks.length}`)
console.log(``)

const adapterConfig: AdapterConfig = {
  model: MODEL,
  apiKey,
  maxSteps: 10,
  timeoutMs: 60_000,
}

const results = []
for (const task of tasks) {
  console.log(`--- Running: ${task.id} ---`)
  try {
    const adapter = new BareAgentAdapter((config) =>
      new OpenRouterProvider({ apiKey: config.apiKey, model: config.model })
    )
    const result = await runTask({ task, adapter, adapterConfig })
    results.push(result)

    // Print step details
    for (const step of result.runResult.steps) {
      if (step.role === "assistant" && step.text) {
        console.log(`  [assistant] ${step.text.slice(0, 150)}`)
      }
      for (const tc of step.toolCalls) {
        console.log(`  [${step.role === "tool" ? "tool-result" : "tool-call"}] ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)})`)
        if (tc.output && step.role === "tool") {
          console.log(`    → ${tc.output.slice(0, 100)}`)
        }
      }
    }

    // Print eval results
    for (const e of result.evalResults) {
      console.log(`  [eval] ${e.criterion.method}: ${e.pass ? "PASS" : "FAIL"} - ${e.details.slice(0, 100)}`)
    }
    console.log(`  tokens: in=${result.runResult.tokens.input} out=${result.runResult.tokens.output}`)
    console.log(``)
  } catch (err) {
    console.error(`  ERROR: ${err}`)
    console.log(``)
  }
}

printSummary(results)

// Save results
if (results.length > 0) {
  const path = await saveResults(results, `live-integration-${Date.now()}`)
  console.log(`\nResults saved to: ${path}`)
}
