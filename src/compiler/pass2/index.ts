import type { LLMProvider } from "../../providers/types.ts"
import type { Pass2Result } from "../types.ts"
import { extractDependencies } from "./extract-deps.ts"
import { generateBindingScript } from "./generate-script.ts"
import { detectPlatformContext } from "./platform.ts"
import { createInstallPolicy, normalizeDependenciesForPlatform } from "./install-policy.ts"
import { simulateAndRepairScript } from "./simulate-and-repair.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("pass2")

/**
 * Pass 2: Environment Binding.
 *
 * Two-phase approach:
 * 1. Extract dependencies from skill + bundle files (single LLM call via extractStructured)
 * 2. Generate idempotent env-binding script from template (single LLM call)
 */
export async function runPass2(
  skillContent: string,
  workDir: string,
  provider: LLMProvider,
): Promise<Pass2Result> {
  // Phase A: extract dependencies from skill + bundle files
  const { dependencies } = await extractDependencies(skillContent, workDir, provider)
  log.info(`Extracted ${dependencies.length} dependencies`)

  // Phase B: detect host platform and normalize dependency commands
  const platform = await detectPlatformContext()
  const policy = createInstallPolicy(platform)
  const normalizedDeps = normalizeDependenciesForPlatform(dependencies, platform)

  // Phase C: generate binding script from template + deps
  const { script: generatedScript } = await generateBindingScript(normalizedDeps, provider, platform, policy)

  // Phase D: simulate install and auto-repair script up to 3 attempts
  const simulation = await simulateAndRepairScript({
    script: generatedScript,
    dependencies: normalizedDeps,
    platform,
    provider,
    workDir,
    maxAttempts: 3,
  })

  if (!simulation.success) {
    throw new Error(`Pass2 env simulation failed after ${simulation.attemptCount} attempts: ${simulation.failureReason ?? "unknown error"}`)
  }

  const bindingScript = simulation.finalScript

  // presenceResults: default false (runtime script does actual check+install)
  const presenceResults = new Map<string, boolean>()
  for (const dep of normalizedDeps) {
    presenceResults.set(dep.name, false)
  }

  return {
    dependencies: normalizedDeps,
    presenceResults,
    bindingScript,
    simulation: {
      attemptCount: simulation.attemptCount,
      success: simulation.success,
      failureReason: simulation.failureReason,
      finalScriptValidated: simulation.finalScriptValidated,
    },
  }
}
