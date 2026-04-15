import type { LLMProvider, LLMResponse, CompletionParams, LLMToolResult } from "../providers/types.ts"
import type { ConversationLog } from "./conversation-logger.ts"

/**
 * Decorator that logs every LLM request/response to a ConversationLog.
 * Wraps any LLMProvider transparently.
 */
export class LoggingProvider implements LLMProvider {
  readonly name: string

  constructor(
    private inner: LLMProvider,
    private log: ConversationLog,
  ) {
    this.name = inner.name
  }

  async complete(params: CompletionParams): Promise<LLMResponse> {
    this.log.logRequest(params, "complete")
    const response = await this.inner.complete(params)
    this.log.logResponse(response)
    return response
  }

  async completeWithToolResults(
    params: CompletionParams,
    toolResults: LLMToolResult[],
    previousResponse: LLMResponse,
  ): Promise<LLMResponse> {
    this.log.logRequest(params, "completeWithToolResults", toolResults)
    const response = await this.inner.completeWithToolResults(params, toolResults, previousResponse)
    this.log.logResponse(response)
    return response
  }
}
