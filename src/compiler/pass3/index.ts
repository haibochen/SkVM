import { z } from "zod"
import type { LLMProvider } from "../../providers/types.ts"
import { extractStructured } from "../../providers/structured.ts"
import { isProviderError } from "../../providers/errors.ts"
import type { SCR, TCP, WorkflowDAG, WorkflowStep, ParallelismAnnotation } from "../../core/types.ts"
import { WorkflowStepSchema } from "../../core/types.ts"
import type { Pass3Result } from "../types.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("pass3")

const ParallelGroupSchema = z.object({
  stepIds: z.array(z.string()).min(2),
  reason: z.string().default(""),
})

const Pass3PlanSchema = z.object({
  hasParallelism: z.boolean(),
  reasoning: z.string().default(""),
  steps: z.array(WorkflowStepSchema).default([]),
  parallelGroups: z.array(ParallelGroupSchema).default([]),
})

type Pass3Plan = z.infer<typeof Pass3PlanSchema>

export async function runPass3(
  skillContent: string,
  scr: SCR,
  tcp: TCP,
  provider: LLMProvider,
  bundleFiles?: Map<string, string>,
): Promise<Pass3Result> {
  void tcp
  void bundleFiles

  try {
    const { result } = await extractStructured({
      provider,
      schema: Pass3PlanSchema,
      schemaName: "pass3_parallel_plan",
      schemaDescription: "A conservative sub-agent parallelism plan for a skill workflow",
      system: buildSystemPrompt(),
      prompt: buildUserPrompt(skillContent, scr),
      maxRetries: 2,
      maxTokens: 4000,
    })

    const dag = normalizePlan(result)
    log.info(`Parallel groups: ${dag.parallelism.length}, DAG steps: ${dag.steps.length}`)
    return { dag }
  } catch (err) {
    // Provider outages must surface — otherwise you silently get a compile
    // result that says "no parallelism detected" and can't tell whether
    // that's the real answer or a rate-limit masquerading as one.
    if (isProviderError(err)) throw err
    log.warn(`Pass 3 analysis failed, falling back to no parallelism: ${err}`)
    return { dag: emptyDag() }
  }
}

function buildSystemPrompt(): string {
  return [
    "You analyze a skill document and decide whether it contains real opportunities for sub-agent parallelism.",
    "",
    "Be conservative:",
    "- Prefer false negatives over speculative parallelism.",
    "- Only mark steps as parallel when they can start from the same available inputs and can be merged later.",
    "- If the workflow is mostly linear, return hasParallelism=false.",
    "- Do not decompose into many tiny steps. Use 2-6 meaningful workflow nodes.",
    "- Use task-level sub-agent parallelism only. Do not classify DLP, ILP, or TLP.",
  ].join("\n")
}

function buildUserPrompt(skillContent: string, scr: SCR): string {
  const purposeSummary = scr.purposes
    .map((purpose) => {
      const primitives = purpose.currentPath.primitives
        .map((prim) => `${prim.id}(${prim.minLevel})`)
        .join(", ")
      return `- ${purpose.id}: ${purpose.description}\n  Primitives: ${primitives}`
    })
    .join("\n")

  return [
    "Analyze whether this skill defines any workflow branches that can be handled by separate sub-agents in parallel.",
    "",
    "Return hasParallelism=false when:",
    "- later work depends directly on earlier work with no real branching",
    "- the skill only describes one main execution path",
    "- the branches would mostly duplicate context gathering rather than save time",
    "",
    "Return hasParallelism=true only when:",
    "- there are at least two meaningful sibling tasks",
    "- those tasks can start after the same prerequisite step or from the initial state",
    "- there is a clear merge point or downstream continuation",
    "",
    "If you find parallelism:",
    "- include a small DAG with explicit dependsOn edges",
    "- include one or more parallelGroups, each containing the sibling step IDs that may run concurrently",
    "",
    "Skill purposes:",
    purposeSummary,
    "",
    "Skill content:",
    "```markdown",
    skillContent,
    "```",
  ].join("\n")
}

function normalizePlan(plan: {
  hasParallelism: boolean
  reasoning?: string
  steps?: Array<{
    id: string
    description: string
    primitives: string[]
    dependsOn?: string[]
  }>
  parallelGroups?: Array<{
    stepIds: string[]
    reason?: string
  }>
}): WorkflowDAG {
  if (!plan.hasParallelism) return emptyDag()

  const steps = normalizeSteps(plan.steps ?? [])
  if (steps.length < 3) return emptyDag()
  if (hasCycle(steps)) {
    log.warn("Pass 3 returned a cyclic DAG; dropping parallelism")
    return emptyDag()
  }

  const stepIds = new Set(steps.map((step) => step.id))
  const parallelism = (plan.parallelGroups ?? [])
    .map((group) => normalizeParallelGroup(group, stepIds))
    .filter((group): group is ParallelismAnnotation => group !== null)

  if (parallelism.length === 0) return emptyDag()
  if (!hasRealFanOut(steps, parallelism)) return emptyDag()

  return { steps, parallelism }
}

function normalizeSteps(rawSteps: Array<{
  id: string
  description: string
  primitives: string[]
  dependsOn?: string[]
}>): WorkflowStep[] {
  const steps: WorkflowStep[] = []
  const seen = new Set<string>()

  for (const raw of rawSteps) {
    const id = raw.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    steps.push({
      id,
      description: raw.description.trim(),
      primitives: [...new Set(raw.primitives.map((value) => value.trim()).filter(Boolean))],
      dependsOn: [...new Set((raw.dependsOn ?? []).map((value) => value.trim()).filter(Boolean))],
    })
  }

  const validIds = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    step.dependsOn = step.dependsOn.filter((dep) => validIds.has(dep) && dep !== step.id)
  }

  return steps
}

function normalizeParallelGroup(
  group: { stepIds: string[]; reason?: string },
  stepIds: Set<string>,
): ParallelismAnnotation | null {
  const uniqueStepIds = [...new Set(group.stepIds.filter((stepId) => stepIds.has(stepId)))]
  if (uniqueStepIds.length < 2) return null
  const reason = group.reason?.trim() ?? ""

  return {
    type: "tlp",
    steps: uniqueStepIds,
    mechanism: reason ? `sub_agent: ${reason}` : "sub_agent",
    fallback: "sequential_execution",
  }
}

function hasCycle(steps: WorkflowStep[]): boolean {
  const stepMap = new Map(steps.map((step) => [step.id, step]))
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function visit(stepId: string): boolean {
    if (inStack.has(stepId)) return true
    if (visited.has(stepId)) return false

    visited.add(stepId)
    inStack.add(stepId)
    const step = stepMap.get(stepId)
    if (step) {
      for (const dep of step.dependsOn) {
        if (visit(dep)) return true
      }
    }
    inStack.delete(stepId)
    return false
  }

  for (const step of steps) {
    if (visit(step.id)) return true
  }

  return false
}

function hasRealFanOut(steps: WorkflowStep[], parallelism: ParallelismAnnotation[]): boolean {
  const stepMap = new Map(steps.map((step) => [step.id, step]))

  return parallelism.some((annotation) => {
    if (annotation.steps.length < 2) return false

    const dependencyKeys = annotation.steps.map((stepId) => {
      const deps = stepMap.get(stepId)?.dependsOn ?? []
      return deps.slice().sort().join("|")
    })
    const hasSharedEntry = new Set(dependencyKeys).size === 1

    const hasSharedDownstream = steps.some((step) => {
      const depSet = new Set(step.dependsOn)
      return annotation.steps.filter((member) => depSet.has(member)).length >= 2
    })

    return hasSharedEntry || hasSharedDownstream
  })
}

function emptyDag(): WorkflowDAG {
  return { steps: [], parallelism: [] }
}

export function generateParallelismSection(dag: WorkflowDAG): string {
  if (dag.parallelism.length === 0 || dag.steps.length === 0) return ""

  const stepMap = new Map(dag.steps.map((step) => [step.id, step]))
  let section = "\n\n---\n\n"
  section += "**Parallel execution hint:** If your harness supports sub-agents, you may launch separate sub-agents for the following sibling subtasks once their shared prerequisites are satisfied. Merge their outputs before continuing to dependent steps.\n\n"

  for (let i = 0; i < dag.parallelism.length; i++) {
    const group = dag.parallelism[i]!
    section += `**Group ${i + 1}:**\n`
    for (const stepId of group.steps) {
      const step = stepMap.get(stepId)
      section += `- **${stepId}**: ${step?.description ?? "(no description)"}\n`
    }
    section += "\nStart one sub-agent per step in this group, then continue only after the required branch outputs are available.\n\n"
  }
  return section
}

export function generateWorkflowDagDocument(dag: WorkflowDAG): string {
  if (dag.parallelism.length === 0 || dag.steps.length === 0) return ""

  return [
    "## Workflow DAG",
    "",
    "```mermaid",
    generateMermaidGraph(dag),
    "```",
    "",
  ].join("\n")
}

function generateMermaidGraph(dag: WorkflowDAG): string {
  const lines = ["graph TD"]

  for (const step of dag.steps) {
    lines.push(`  ${sanitizeNodeId(step.id)}[\"${escapeMermaidLabel(step.description || step.id)}\"]`)
  }

  for (const step of dag.steps) {
    for (const dep of step.dependsOn) {
      lines.push(`  ${sanitizeNodeId(dep)} --> ${sanitizeNodeId(step.id)}`)
    }
  }

  return lines.join("\n")
}

function sanitizeNodeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_")
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'")
}