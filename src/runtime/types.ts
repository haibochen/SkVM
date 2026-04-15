import type { ToolCall, RunResult } from "../core/types.ts"
import type { LLMResponse } from "../providers/types.ts"

// ---------------------------------------------------------------------------
// Interceptor hooks for the agent loop
// ---------------------------------------------------------------------------

/**
 * Called before each LLM call. Can short-circuit the LLM call
 * by returning a replacement response (e.g., solidified code execution).
 */
export interface BeforeLLMHook {
  (ctx: BeforeLLMContext): Promise<BeforeLLMResult>
}

export interface BeforeLLMContext {
  prompt: string
  workDir: string
  iteration: number
  previousToolCalls: ToolCall[]
}

export type BeforeLLMResult =
  | { action: "passthrough" }
  | { action: "replace"; toolResults: ToolCall[]; text?: string }

/**
 * Called after each LLM response. Can inspect tool calls
 * for monitoring (e.g., code solidification skeleton matching).
 */
export interface AfterLLMHook {
  (ctx: AfterLLMContext): Promise<void>
}

export interface AfterLLMContext {
  response: LLMResponse
  iteration: number
  workDir: string
}

/**
 * Called after each tool execution. Can record tool results
 * for failure tracking.
 */
export interface AfterToolHook {
  (ctx: AfterToolContext): Promise<void>
}

export interface AfterToolContext {
  toolCall: ToolCall
  workDir: string
  iteration: number
}

/**
 * Called after the full run completes.
 */
export interface AfterRunHook {
  (ctx: AfterRunContext): Promise<void>
}

export interface AfterRunContext {
  result: RunResult
  skillId?: string
  success: boolean
}

/** Collection of all hooks for the agent loop */
export interface RuntimeHooks {
  beforeLLM?: BeforeLLMHook[]
  afterLLM?: AfterLLMHook[]
  afterTool?: AfterToolHook[]
  afterRun?: AfterRunHook[]
}

// ---------------------------------------------------------------------------
// Variant registry
// ---------------------------------------------------------------------------

export interface SkillVariantInfo {
  id: string
  path: string
  type: "verbose" | "compiled" | "jit"
  model?: string
  harness?: string
  score?: number
  runCount?: number
}
