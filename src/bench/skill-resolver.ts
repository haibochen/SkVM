import path from "node:path"
import { loadSkill } from "../core/skill-loader.ts"
import type { ResolvedSkill } from "../core/skill-loader.ts"
import type { BenchTask } from "./types.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("skill-resolver")

export type { ResolvedSkill }
export { loadSkill }

/**
 * Resolve the skill(s) bound to a task. The task's `skill` field is now a path
 * (or array of paths), relative to the task directory or absolute. A value of
 * `null` means "no-skill task"; `undefined` means "no binding configured".
 *
 * Returns an empty array when no skill is configured. Throws when a configured
 * path does not exist — bench refuses to silently run without a skill when one
 * was explicitly requested.
 */
export async function resolveTaskSkills(task: BenchTask): Promise<ResolvedSkill[]> {
  if (task.skill === null || task.skill === undefined) return []

  const refs = Array.isArray(task.skill) ? task.skill : [task.skill]
  const baseDir = task.taskDir ?? process.cwd()

  const results: ResolvedSkill[] = []
  for (const ref of refs) {
    const absolute = path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref)
    try {
      results.push(await loadSkill(absolute))
    } catch (err) {
      log.warn(`Task ${task.id}: failed to load skill at ${absolute}: ${err instanceof Error ? err.message : err}`)
      throw err
    }
  }
  return results
}
