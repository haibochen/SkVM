import { test, expect, describe } from "bun:test"
import { parseConvLogContent } from "../../src/core/conv-log-parser.ts"
import { normalizeParamDef } from "../../src/jit-boost/types.ts"

// ---------------------------------------------------------------------------
// Conv Log Parser Tests
// ---------------------------------------------------------------------------

describe("parseConvLogContent", () => {
  test("extracts execute_command tool calls", () => {
    const ndjson = [
      JSON.stringify({
        type: "request",
        ts: "2026-01-01T00:00:00Z",
        method: "complete",
        messages: [{ role: "user", content: "extract text from report.pdf" }],
      }),
      JSON.stringify({
        type: "response",
        ts: "2026-01-01T00:00:01Z",
        text: "",
        toolCalls: [
          {
            id: "tc_1",
            name: "execute_command",
            arguments: { command: 'python3 << \'EOF\'\nimport pdfplumber\nwith pdfplumber.open("report.pdf") as pdf:\n    for page in pdf.pages:\n        print(page.extract_text())\nEOF' },
          },
        ],
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      }),
    ].join("\n")

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(1)
    expect(result[0]!.toolName).toBe("execute_command")
    expect(result[0]!.code).toContain("pdfplumber")
    expect(result[0]!.code).toContain("extract_text")
    expect(result[0]!.turnIndex).toBe(0) // first response entry
  })

  test("extracts write_file tool calls", () => {
    const ndjson = JSON.stringify({
      type: "response",
      ts: "2026-01-01T00:00:01Z",
      text: "",
      toolCalls: [
        {
          id: "tc_1",
          name: "write_file",
          arguments: { path: "script.py", content: "import pypdf\nreader = pypdf.PdfReader('test.pdf')\nprint(len(reader.pages))" },
        },
      ],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
    })

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(1)
    expect(result[0]!.toolName).toBe("write_file")
    expect(result[0]!.code).toContain("pypdf")
  })

  test("skips responses with no tool calls", () => {
    const ndjson = [
      JSON.stringify({
        type: "response",
        ts: "2026-01-01T00:00:00Z",
        text: "I'll help you extract text from the PDF.",
        toolCalls: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "end_turn",
      }),
      JSON.stringify({
        type: "response",
        ts: "2026-01-01T00:00:01Z",
        text: "",
        toolCalls: [
          { id: "tc_1", name: "execute_command", arguments: { command: "pdftotext report.pdf output.txt" } },
        ],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      }),
    ].join("\n")

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe("pdftotext report.pdf output.txt")
  })

  test("skips non-monitorable tools (read_file, list_directory)", () => {
    const ndjson = [
      JSON.stringify({
        type: "response",
        ts: "2026-01-01T00:00:00Z",
        text: "",
        toolCalls: [
          { id: "tc_1", name: "read_file", arguments: { path: "data.txt" } },
          { id: "tc_2", name: "list_directory", arguments: { path: "." } },
          { id: "tc_3", name: "execute_command", arguments: { command: "echo hello world" } },
        ],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      }),
    ].join("\n")

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(1)
    expect(result[0]!.toolName).toBe("execute_command")
  })

  test("skips tool calls with empty content", () => {
    const ndjson = JSON.stringify({
      type: "response",
      ts: "2026-01-01T00:00:00Z",
      text: "",
      toolCalls: [
        { id: "tc_1", name: "execute_command", arguments: { command: "" } },
        { id: "tc_2", name: "write_file", arguments: { path: "empty.txt", content: "" } },
      ],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
    })

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(0)
  })

  test("handles multiple tool calls in one response", () => {
    const ndjson = JSON.stringify({
      type: "response",
      ts: "2026-01-01T00:00:00Z",
      text: "",
      toolCalls: [
        { id: "tc_1", name: "execute_command", arguments: { command: "pdftotext doc1.pdf doc1.txt" } },
        { id: "tc_2", name: "execute_command", arguments: { command: "pdftotext doc2.pdf doc2.txt" } },
      ],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: "tool_use",
    })

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(2)
    expect(result[0]!.code).toContain("doc1")
    expect(result[1]!.code).toContain("doc2")
  })

  test("handles malformed JSON lines gracefully", () => {
    const ndjson = [
      "not valid json",
      JSON.stringify({
        type: "response",
        ts: "2026-01-01T00:00:00Z",
        text: "",
        toolCalls: [
          { id: "tc_1", name: "execute_command", arguments: { command: "echo valid" } },
        ],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "tool_use",
      }),
      "",  // empty line
    ].join("\n")

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(1)
    expect(result[0]!.code).toBe("echo valid")
  })

  test("tracks turnIndex correctly across responses", () => {
    const ndjson = [
      JSON.stringify({ type: "request", ts: "2026-01-01T00:00:00Z", method: "complete", messages: [] }),
      JSON.stringify({
        type: "response", ts: "2026-01-01T00:00:01Z", text: "",
        toolCalls: [{ id: "tc_1", name: "execute_command", arguments: { command: "cmd1" } }],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "tool_use",
      }),
      JSON.stringify({ type: "request", ts: "2026-01-01T00:00:02Z", method: "completeWithToolResults", messages: [] }),
      JSON.stringify({
        type: "response", ts: "2026-01-01T00:00:03Z", text: "",
        toolCalls: [{ id: "tc_2", name: "execute_command", arguments: { command: "cmd2" } }],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "tool_use",
      }),
    ].join("\n")

    const result = parseConvLogContent(ndjson)
    expect(result).toHaveLength(2)
    // turnIndex counts response entries only (request entries are skipped)
    expect(result[0]!.turnIndex).toBe(0)
    expect(result[1]!.turnIndex).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// normalizeParamDef Tests
// ---------------------------------------------------------------------------

describe("normalizeParamDef", () => {
  test("normalizes legacy string format", () => {
    const def = normalizeParamDef("city", "string")
    expect(def.type).toBe("string")
    expect(def.description).toBe("city")
    expect(def.extractPattern).toBeUndefined()
  })

  test("normalizes legacy number format", () => {
    const def = normalizeParamDef("count", "number")
    expect(def.type).toBe("number")
    expect(def.description).toBe("count")
  })

  test("passes through rich ParamDef unchanged", () => {
    const rich = { type: "string" as const, description: "The input PDF file", extractPattern: "(\\S+\\.pdf)" }
    const def = normalizeParamDef("inputPdf", rich)
    expect(def).toBe(rich) // same reference
    expect(def.extractPattern).toBe("(\\S+\\.pdf)")
  })
})
