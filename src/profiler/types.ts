import type { EvalCheckpoint, EvalCriterion, Level } from "../core/types.ts"
import type { FailureReport } from "./failure-diagnostics.ts"

/** A single microbenchmark test instance produced by a generator */
export interface MicrobenchmarkInstance {
  prompt: string
  setupFiles?: Record<string, string>
  eval: EvalCriterion
}

/** Generator for a single primitive capability */
export interface MicrobenchmarkGenerator {
  readonly primitiveId: string
  /** Human-readable description of what each level tests */
  readonly descriptions: Record<Exclude<Level, "L0">, string>
  generate(level: Exclude<Level, "L0">): MicrobenchmarkInstance
}

/** Result of evaluating one instance */
export interface InstanceResult {
  instance: number
  passed: boolean
  details: string
  durationMs: number
  /** Full failure diagnostics (present when instance failed) */
  failureReport?: FailureReport
  /** Per-checkpoint scoring breakdown (present when eval script outputs structured JSON) */
  checkpoints?: EvalCheckpoint[]
}

/** Result of profiling one level of one primitive */
export interface LevelResult {
  level: Exclude<Level, "L0">
  passed: boolean
  passCount: number
  totalCount: number
  instances: InstanceResult[]
  durationMs: number
  costUsd: number
}

/** Result of profiling one primitive (all levels) */
export interface PrimitiveResult {
  primitiveId: string
  highestLevel: Level
  levelResults: LevelResult[]
  calibrationNote?: string
}
