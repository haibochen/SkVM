import { test, expect, describe } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConversationLog } from "../../src/core/conversation-logger.ts"
import type { CompletionParams } from "../../src/providers/types.ts"

describe("ConversationLog", () => {
  test("logRequest snapshots messages instead of storing reference", async () => {
    const filePath = path.join(tmpdir(), `conv-test-${Date.now()}.jsonl`)
    const log = new ConversationLog(filePath)

    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "hello" },
    ]
    const params: CompletionParams = {
      messages,
      system: "test",
      tools: [],
      maxTokens: 1024,
    }

    // First log: 1 message
    log.logRequest(params, "complete")

    // Mutate the array (simulating agent-loop.ts line 172)
    messages.push(
      { role: "assistant", content: "response 1" },
      { role: "user", content: "tool result 1" },
    )

    // Second log: 3 messages
    log.logRequest(params, "completeWithToolResults")

    messages.push(
      { role: "assistant", content: "response 2" },
      { role: "user", content: "tool result 2" },
    )

    // Third log: 5 messages
    log.logRequest(params, "completeWithToolResults")

    await log.finalize()

    const content = await Bun.file(filePath).text()
    const entries = content.trim().split("\n").map((line) => JSON.parse(line))

    const requestEntries = entries.filter((e: { type: string }) => e.type === "request")
    expect(requestEntries).toHaveLength(3)
    expect(requestEntries[0].messages).toHaveLength(1)
    expect(requestEntries[1].messages).toHaveLength(3)
    expect(requestEntries[2].messages).toHaveLength(5)
  })
})
