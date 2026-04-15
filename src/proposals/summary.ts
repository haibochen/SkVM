/**
 * Derived views over a loaded proposal.
 *
 * storage.ts owns the raw schema (ProposalMeta + ProposalHistoryFile). This
 * module owns the *derived* numbers that CLI / HTML presenters want:
 * baseline→best deltas, per-task deltas, cost totals, root cause text. Pure
 * functions, no I/O — callers pass in a LoadedProposal.
 */

import type { LoadedProposal } from "./storage.ts"
import type { HistoryEntry } from "../jit-optimize/types.ts"

/**
 * Slice of RoundResult used by summaries. The full RoundResult interface
 * requires `historyEntry: any`, but Zod's parsed shape makes it optional —
 * importing the interface directly trips TS. We don't touch historyEntry
 * here, so a local structural type is cleaner than a cast.
 */
type RoundView = {
  round: number
  isBaseline: boolean
  trainScore: number | null
  testScore: number | null
  trainPassed: number
  trainTotal: number
  testPassed: number
  testTotal: number
  perTaskTrainScores: Record<string, number>
  perTaskTestScores: Record<string, number>
  targetAgent: { costUsd: number }
  evalJudge: { costUsd: number }
  optimizer: { costUsd: number } | null
}

export interface PerTaskDelta {
  taskId: string
  baseline: number | null
  best: number | null
  delta: number | null
}

export interface RoundLine {
  round: number
  isBaseline: boolean
  isBest: boolean
  trainScore: number | null
  testScore: number | null
  trainPassed: number
  trainTotal: number
  changedFiles: string[]
  deltaVsBaseline: number | null
  costTotalUsd: number
  optimizerCostUsd: number
}

export interface ProposalSummaryView {
  /** Baseline row (round-0). May be null if no rounds data yet. */
  baseline: RoundView | null
  /** The round chosen as bestRound. May be null if no rounds data. */
  best: RoundView | null
  /** best.trainScore - baseline.trainScore, or null if either is missing. */
  trainDelta: number | null
  testDelta: number | null
  /** Per-task deltas at best round vs baseline (train set). */
  perTaskDeltas: PerTaskDelta[]
  /** Root cause the optimizer diagnosed on the best round, if any. */
  bestRoundRootCause: string | null
  /** Changed files on the best round, if any. */
  bestRoundChangedFiles: string[]
  /** Flat row-ready view of every round for table rendering. */
  rounds: RoundLine[]
  /** Sum of targetAgent + evalJudge + optimizer across all rounds. */
  totalCostUsd: number
  /** Sum of optimizer-only costs across all rounds. */
  totalOptimizerCostUsd: number
}

function roundCostTotal(r: RoundView): number {
  return r.targetAgent.costUsd + r.evalJudge.costUsd + (r.optimizer?.costUsd ?? 0)
}

export function summarizeProposal(p: LoadedProposal): ProposalSummaryView {
  const rounds: RoundView[] = (p.history?.rounds ?? []) as RoundView[]
  const entries = p.history?.entries ?? []
  const bestRoundNum = p.meta.bestRound

  const baseline = rounds.find((r) => r.isBaseline) ?? rounds.find((r) => r.round === 0) ?? null
  const best = rounds.find((r) => r.round === bestRoundNum) ?? null

  const trainDelta =
    baseline?.trainScore != null && best?.trainScore != null
      ? best.trainScore - baseline.trainScore
      : null
  const testDelta =
    baseline?.testScore != null && best?.testScore != null
      ? best.testScore - baseline.testScore
      : null

  const perTaskDeltas: PerTaskDelta[] = []
  if (baseline && best) {
    const taskIds = new Set<string>([
      ...Object.keys(baseline.perTaskTrainScores),
      ...Object.keys(best.perTaskTrainScores),
    ])
    for (const taskId of Array.from(taskIds).sort()) {
      const b = baseline.perTaskTrainScores[taskId] ?? null
      const t = best.perTaskTrainScores[taskId] ?? null
      perTaskDeltas.push({
        taskId,
        baseline: b,
        best: t,
        delta: b != null && t != null ? t - b : null,
      })
    }
  }

  const bestEntry: HistoryEntry | undefined = entries.find((e) => e.round === bestRoundNum)

  const baselineTrain = baseline?.trainScore ?? null
  const roundLines: RoundLine[] = rounds.map((r) => {
    const entry = entries.find((e) => e.round === r.round)
    const deltaVsBaseline =
      r.trainScore != null && baselineTrain != null ? r.trainScore - baselineTrain : null
    return {
      round: r.round,
      isBaseline: r.isBaseline,
      isBest: r.round === bestRoundNum,
      trainScore: r.trainScore,
      testScore: r.testScore,
      trainPassed: r.trainPassed,
      trainTotal: r.trainTotal,
      changedFiles: entry?.changedFiles ?? [],
      deltaVsBaseline,
      costTotalUsd: roundCostTotal(r),
      optimizerCostUsd: r.optimizer?.costUsd ?? 0,
    }
  })

  const totalCostUsd = rounds.reduce((sum, r) => sum + roundCostTotal(r), 0)
  const totalOptimizerCostUsd = rounds.reduce((sum, r) => sum + (r.optimizer?.costUsd ?? 0), 0)

  return {
    baseline,
    best,
    trainDelta,
    testDelta,
    perTaskDeltas,
    bestRoundRootCause: bestEntry?.rootCause ?? null,
    bestRoundChangedFiles: bestEntry?.changedFiles ?? [],
    rounds: roundLines,
    totalCostUsd,
    totalOptimizerCostUsd,
  }
}
