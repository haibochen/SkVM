/**
 * Conversation log parser — extracts tool call code from NDJSON conv logs.
 *
 * Conv logs are written by ConversationLog (conversation-logger.ts) as NDJSON
 * with "request" and "response" entries. Response entries contain toolCalls[]
 * with the raw LLM tool call arguments.
 */

export interface ExtractedToolCode {
  toolName: string   // "execute_command" | "write_file"
  code: string       // arguments.command or arguments.content
  turnIndex: number  // which response entry this came from
}

/**
 * Parse a conv log NDJSON file from disk and extract tool call code.
 */
export async function parseConvLog(filePath: string): Promise<ExtractedToolCode[]> {
  const content = await Bun.file(filePath).text()
  return parseConvLogContent(content)
}

/**
 * Parse conv log NDJSON content (string) and extract tool call code.
 * Useful for testing without disk I/O.
 */
export function parseConvLogContent(ndjsonContent: string): ExtractedToolCode[] {
  const results: ExtractedToolCode[] = []
  let turnIndex = 0

  for (const line of ndjsonContent.split("\n")) {
    if (!line.trim()) continue

    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.type !== "response") continue

    const toolCalls = entry.toolCalls as Array<{
      name: string
      arguments: Record<string, unknown>
    }> | undefined

    if (!toolCalls || toolCalls.length === 0) {
      turnIndex++
      continue
    }

    for (const tc of toolCalls) {
      let code: string | undefined

      if (tc.name === "execute_command") {
        code = tc.arguments?.command as string | undefined
      } else if (tc.name === "write_file") {
        code = tc.arguments?.content as string | undefined
      }

      if (code && code.length > 0) {
        results.push({ toolName: tc.name, code, turnIndex })
      }
    }

    turnIndex++
  }

  return results
}
