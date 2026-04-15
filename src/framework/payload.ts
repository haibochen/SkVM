/**
 * Payload hydration/persistence for custom eval criteria.
 *
 * These helpers are evaluator-agnostic — they consult the `customEvaluators`
 * registry and dispatch to each evaluator's own `loadPayload` / `savePayload`
 * hooks. Loaders (bench/loader.ts, bench/custom-plan.ts, jit-optimize/
 * task-source.ts) call `hydrateEvalPayloads` after zod-parsing a task.json so
 * every `custom` criterion arrives at the evaluator with its per-task data
 * attached. `writeTask` calls `persistEvalPayloads` symmetrically.
 *
 * This module deliberately lives in `framework/` (not `bench/`) so it has no
 * dependency on any specific evaluator implementation. The barrel at
 * `bench/evaluators/index.ts` is the place where bridges are side-effect-
 * imported and registered.
 */

import type { EvalCriterion } from "../core/types.ts"
import { customEvaluators } from "./types.ts"

/**
 * Populate `criterion.payload` for every custom criterion that has no inline
 * payload by calling the evaluator's `loadPayload` hook with `taskDir`.
 *
 * Mutates `criteria` in place. Criteria whose payload is already set (e.g.
 * inlined in task.json) are left alone. Criteria whose evaluator has no
 * `loadPayload` hook are left with `payload: undefined` — the evaluator's
 * `run` hook is responsible for emitting a clear error in that case.
 */
export async function hydrateEvalPayloads(
  criteria: EvalCriterion[],
  taskDir: string,
): Promise<void> {
  for (const c of criteria) {
    if (c.method !== "custom") continue
    const evaluator = customEvaluators.get(c.evaluatorId)
    if (c.payload === undefined && evaluator?.loadPayload) {
      c.payload = await evaluator.loadPayload(taskDir)
    }
    // Load-time validation: evaluators with structured payloads (e.g.
    // junit-grade) fail fast here so authoring bugs surface at bench/optimize
    // startup instead of after the adapter has already spent LLM tokens.
    if (evaluator?.validatePayload && c.payload !== undefined) {
      try {
        evaluator.validatePayload(c.payload)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `[${c.evaluatorId}] payload validation failed in ${taskDir}: ${msg}`,
        )
      }
    }
  }
}

/**
 * Persist each custom criterion's payload to `taskDir` via the evaluator's
 * `savePayload` hook. Returns the set of criterion indices whose payloads
 * were written to disk so the caller (`writeTask`) can strip them from the
 * serialized task.json and avoid double storage.
 *
 * Criteria without a `savePayload` hook are skipped — their payload stays
 * inline in task.json as a JSON value.
 */
export async function persistEvalPayloads(
  criteria: EvalCriterion[],
  taskDir: string,
): Promise<Set<number>> {
  const persisted = new Set<number>()
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i]!
    if (c.method !== "custom" || c.payload === undefined) continue
    const evaluator = customEvaluators.get(c.evaluatorId)
    if (evaluator?.savePayload) {
      await evaluator.savePayload(taskDir, c.payload)
      persisted.add(i)
    }
  }
  return persisted
}
