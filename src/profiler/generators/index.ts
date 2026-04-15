import type { MicrobenchmarkGenerator } from "../types.ts"

const registry = new Map<string, MicrobenchmarkGenerator>()

export function registerGenerator(gen: MicrobenchmarkGenerator) {
  registry.set(gen.primitiveId, gen)
}

export function getGenerator(primitiveId: string): MicrobenchmarkGenerator | undefined {
  return registry.get(primitiveId)
}

export function getAllGenerators(): MicrobenchmarkGenerator[] {
  return [...registry.values()]
}

export function getRegisteredIds(): string[] {
  return [...registry.keys()]
}

// Explicit imports for all generators
import genCodePython from "./gen-code-python.ts"
import genCodeJavascript from "./gen-code-javascript.ts"
import genCodeShell from "./gen-code-shell.ts"
import genCodeSql from "./gen-code-sql.ts"
import genCodeHtml from "./gen-code-html.ts"
import genTextStructured from "./gen-text-structured.ts"
import genTextLong from "./gen-text-long.ts"
import genTextProse from "./gen-text-prose.ts"
import genRegex from "./gen-regex.ts"
import reasonArithmetic from "./reason-arithmetic.ts"
import reasonLogic from "./reason-logic.ts"
import reasonSpatial from "./reason-spatial.ts"
import reasonPlanning from "./reason-planning.ts"
import reasonAnalysis from "./reason-analysis.ts"
import toolFileRead from "./tool-file-read.ts"
import toolFileWrite from "./tool-file-write.ts"
import toolExec from "./tool-exec.ts"
import toolCallFormat from "./tool-call-format.ts"
import toolCallBatch from "./tool-call-batch.ts"
import toolWeb from "./tool-web.ts"
import toolBrowser from "./tool-browser.ts"
import followFormat from "./follow-format.ts"
import followConstraint from "./follow-constraint.ts"
import followProcedure from "./follow-procedure.ts"
import followDelegation from "./follow-delegation.ts"
import followStyle from "./follow-style.ts"

const allGenerators: MicrobenchmarkGenerator[] = [
  genCodePython,
  genCodeJavascript,
  genCodeShell,
  genCodeSql,
  genCodeHtml,
  genTextStructured,
  genTextLong,
  genTextProse,
  genRegex,
  reasonArithmetic,
  reasonLogic,
  reasonSpatial,
  reasonPlanning,
  reasonAnalysis,
  toolFileRead,
  toolFileWrite,
  toolExec,
  toolCallFormat,
  toolCallBatch,
  toolWeb,
  toolBrowser,
  followFormat,
  followConstraint,
  followProcedure,
  followDelegation,
  followStyle,
]

for (const gen of allGenerators) {
  registerGenerator(gen)
}
