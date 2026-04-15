import { z } from "zod"
import type {
  SCR, TCP, Level, Transform, CapabilityGap, TokenUsage,
  WorkflowDAG, DependencyEntry, ParallelismAnnotation,
} from "../core/types.ts"

// ---------------------------------------------------------------------------
// Failure Context (used by pass1 for JIT recompilation)
// ---------------------------------------------------------------------------

export const FailureContextSchema = z.object({
  classification: z.enum(["task-specific", "systematic"]),
  patterns: z.array(z.object({
    toolName: z.string(),
    frequency: z.number(),
    category: z.enum(["tool-error", "logic-error", "timeout", "api-error"]),
    sampleErrors: z.array(z.string()),
  })),
  recoveryTraces: z.array(z.object({
    failedStep: z.number(),
    failedToolName: z.string(),
    failedError: z.string(),
    recoveredAtStep: z.number(),
    recoveryAction: z.string(),
  })),
  sourceVariantId: z.string(),
  runCount: z.number(),
  failureRate: z.number(),
})

export type FailureContext = z.infer<typeof FailureContextSchema>

/** A recorded LLM call during compilation (prompt + response) */
export interface CompilerLLMCall {
  phase: "extractor" | "rewriter" | "compensator" | "jit-compensator"
  purposeId?: string
  prompt: string
  system?: string
  rawResponse: string
}

/** Output of Pass 1: Capability-Based Compilation */
export interface Pass1Result {
  scr: SCR
  gaps: CapabilityGap[]
  pathSelections: PathSelection[]
  transforms: Transform[]
  compiledSkill: string
  /** All compiled files (SKILL.md + bundled files) — populated by new LLM rewrite flow */
  compiledFiles?: Map<string, string>
  tokens: TokenUsage
  llmCalls?: CompilerLLMCall[]
  /** Whether SCR was loaded from cache */
  scrCached?: boolean
}

/** Which implementation path was selected for a purpose */
export interface PathSelection {
  purposeId: string
  selectedPath: "current" | number  // "current" or index into alternativePaths
  reason: string
  substituted: boolean
}

/** Output of Pass 2: Environment Binding */
export interface Pass2Result {
  dependencies: DependencyEntry[]
  presenceResults: Map<string, boolean>
  bindingScript: string
  simulation: {
    attemptCount: number
    success: boolean
    failureReason?: string
    finalScriptValidated: boolean
  }
}

/** Output of Pass 3: Concurrency Extraction */
export interface Pass3Result {
  dag: WorkflowDAG
}

/** Complete compilation output */
export interface CompilationResult {
  skillName: string
  model: string
  harness: string
  compiledAt: string

  pass1: Pass1Result
  pass2: Pass2Result
  pass3: Pass3Result

  compiledSkill: string
  /** All compiled files (SKILL.md + bundled files) */
  compiledFiles?: Map<string, string>
  guardPassed: boolean
  guardViolations: string[]

  tokens: TokenUsage

  /** Which passes were run (e.g. [1], [2], [1,2,3]) */
  passes: number[]

  costUsd: number
  durationMs: number
}

/** Options for the compile pipeline */
export interface CompileOptions {
  skillPath: string
  skillContent: string
  /** Path to skill directory containing SKILL.md and bundle files */
  skillDir?: string
  /** Explicit skill name for output directory (default: derived from skillPath) */
  skillName?: string
  tcp: TCP
  model: string
  harness: string
  /** Which passes to run (default: [1,2,3]) */
  passes?: number[]
  /** Dry run: compute plan without applying transforms */
  dryRun?: boolean
  /** Structured failure context for JIT recompilation */
  failureContext?: FailureContext
}
