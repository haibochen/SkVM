/**
 * SkillsBench Importer
 *
 * Converts SkillsBench tasks and skills into SkVM native bench format.
 * - Extracts skills from per-task directories, deduplicates by content hash
 * - Converts task.toml + instruction.md → task.json
 * - Converts test_outputs.py → grade.py
 * - Copies fixture files (environment data excluding Dockerfile and skills/)
 * - Detects Docker-heavy dependencies → marks hostReady=false
 *
 * Usage:
 *   bun run skvm bench --import=skillsbench --path=~/Projects/skillsbench
 */

import path from "node:path"
import { readdir, mkdir, copyFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { parse as parseTOML } from "smol-toml"
import { copyDirRecursive } from "../../core/fs-utils.ts"
import type { EvalCriterion } from "../../core/types.ts"
import type { BenchTask, Origin } from "../types.ts"
import { writeTask, addFixtureFile } from "../loader.ts"
import { SKVM_SKILLS_DIR } from "../../core/config.ts"
import { createLogger } from "../../core/logger.ts"

const log = createLogger("import-skillsbench")

const SKILLS_DIR = SKVM_SKILLS_DIR

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskToml {
  version?: string
  metadata?: {
    author_name?: string
    author_email?: string
    difficulty?: string
    category?: string
    tags?: string[]
    required_skills?: string[]
    distractor_skills?: string[]
  }
  verifier?: { timeout_sec?: number }
  agent?: { timeout_sec?: number }
  environment?: {
    build_timeout_sec?: number
    cpus?: number
    memory_mb?: number
    storage_mb?: number
  }
}

interface SkillInfo {
  name: string
  /** SHA-256 hash of SKILL.md content */
  hash: string
  /** SKILL.md raw content */
  content: string
  /** Source task directory */
  sourceTaskDir: string
  /** Path to skill directory in SkillsBench */
  sourcePath: string
  /** SKILL.md frontmatter fields */
  frontmatter: { name?: string; description?: string }
}

interface ImportResult {
  imported: string[]
  skipped: string[]
  errors: string[]
  skillsImported: number
  skillCollisions: string[]
}

// ---------------------------------------------------------------------------
// SKILL.md Frontmatter Parser
// ---------------------------------------------------------------------------

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const yaml = match[1]!
  const result: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+):\s*["']?(.*?)["']?\s*$/)
    if (kv) result[kv[1]!] = kv[2]!
  }
  return { name: result.name, description: result.description }
}

// ---------------------------------------------------------------------------
// Skill Extraction & Deduplication
// ---------------------------------------------------------------------------

async function extractAllSkills(
  skillsbenchDir: string,
): Promise<{ skills: Map<string, SkillInfo>; collisions: string[] }> {
  const tasksDir = path.join(skillsbenchDir, "tasks")
  const taskDirs = await readdir(tasksDir, { withFileTypes: true })

  // Collect all skill instances: name -> Map<hash, SkillInfo>
  const registry = new Map<string, Map<string, SkillInfo>>()

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue
    const skillsPath = path.join(tasksDir, taskEntry.name, "environment", "skills")

    let skillEntries: import("node:fs").Dirent[]
    try {
      skillEntries = await readdir(skillsPath, { withFileTypes: true })
    } catch { continue }

    for (const skillEntry of skillEntries) {
      if (!skillEntry.isDirectory()) continue

      const skillDir = path.join(skillsPath, skillEntry.name)
      const skillMdPath = path.join(skillDir, "SKILL.md")

      let content: string
      try {
        content = await Bun.file(skillMdPath).text()
      } catch {
        log.debug(`No SKILL.md in ${skillDir}, skipping`)
        continue
      }

      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
      const frontmatter = parseSkillFrontmatter(content)

      const info: SkillInfo = {
        name: skillEntry.name,
        hash,
        content,
        sourceTaskDir: taskEntry.name,
        sourcePath: skillDir,
        frontmatter,
      }

      if (!registry.has(skillEntry.name)) {
        registry.set(skillEntry.name, new Map())
      }
      const variants = registry.get(skillEntry.name)!
      if (!variants.has(hash)) {
        variants.set(hash, info)
      }
    }
  }

  // Deduplicate: same name + same content → 1 entry; different content → qualified names
  const deduped = new Map<string, SkillInfo>()
  const collisions: string[] = []

  for (const [name, variants] of registry) {
    if (variants.size === 1) {
      // Single variant — use as-is
      deduped.set(name, variants.values().next().value!)
    } else {
      // Multiple variants — pick the most common (first encountered), log collision
      const variantList = [...variants.values()]
      collisions.push(`${name} (${variants.size} variants from: ${variantList.map(v => v.sourceTaskDir).join(", ")})`)

      // First variant gets the canonical name
      deduped.set(name, variantList[0]!)

      // Additional variants get qualified names
      for (let i = 1; i < variantList.length; i++) {
        const variant = variantList[i]!
        const qualifiedName = `${name}-${variant.sourceTaskDir}`
        deduped.set(qualifiedName, { ...variant, name: qualifiedName })
      }
    }
  }

  log.info(`Extracted ${deduped.size} unique skills (${collisions.length} collisions)`)
  return { skills: deduped, collisions }
}

// ---------------------------------------------------------------------------
// Skill Writer
// ---------------------------------------------------------------------------

async function writeSkills(
  skills: Map<string, SkillInfo>,
  taskTomlMap: Map<string, TaskToml>,
): Promise<number> {
  await mkdir(SKILLS_DIR, { recursive: true })
  let count = 0

  for (const [id, info] of skills) {
    const skillDir = path.join(SKILLS_DIR, id)
    await mkdir(skillDir, { recursive: true })

    // Write SKILL.md with path rewriting, flat under skillDir (no version layer)
    const rewrittenContent = rewriteSkillPaths(info.content, id)
    await Bun.write(path.join(skillDir, "SKILL.md"), rewrittenContent)

    // Copy bundle files (scripts/, references/, data/) directly into skillDir
    await copyBundleFiles(info.sourcePath, skillDir)

    count++
  }
  void taskTomlMap  // no longer consumed — kept on signature for caller compat

  log.info(`Wrote ${count} skills to ${SKILLS_DIR}`)
  return count
}

/** Rewrite Docker-style paths in SKILL.md to relative paths */
function rewriteSkillPaths(content: string, skillId: string): string {
  // /root/.claude/skills/<name>/scripts/ → ./scripts/
  // /root/.agents/skills/<name>/scripts/ → ./scripts/
  // etc. for all agent-specific paths
  const agentPaths = [".claude", ".codex", ".opencode", ".goose", ".factory", ".agents", ".gemini"]
  let result = content
  for (const agentDir of agentPaths) {
    const pattern = new RegExp(`/root/${agentDir.replace(".", "\\.")}/skills?/${skillId}/`, "g")
    result = result.replace(pattern, "./")
    // Also handle generic patterns without specific skill name
    const genericPattern = new RegExp(`/root/${agentDir.replace(".", "\\.")}/skills?/[^/]+/`, "g")
    result = result.replace(genericPattern, "./")
  }
  return result
}

/** Copy non-.md files from skill source to version directory */
async function copyBundleFiles(sourcePath: string, destDir: string): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(sourcePath, { withFileTypes: true })
  } catch { return }

  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue

    const src = path.join(sourcePath, entry.name)
    const dest = path.join(destDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest)
    } else {
      await copyFile(src, dest)
    }
  }
}

// ---------------------------------------------------------------------------
// Task Conversion
// ---------------------------------------------------------------------------

/** Parse task.toml */
function parseTaskToml(content: string): TaskToml {
  return parseTOML(content) as unknown as TaskToml
}

/** Detect if a task requires heavy dependencies from its Dockerfile or Docker-only paths in its instruction */
function detectHostReady(dockerfileContent: string, instruction?: string): boolean {
  const lower = dockerfileContent.toLowerCase()
  const heavyPatterns = [
    /\b(maven|mvn)\b/,
    /\bjdk\b/, /\bjava\b.*\b(install|sdk)\b/,
    /\bgradle\b/,
    /\bffmpeg\b/, /\blibav\b/,
    /\bcuda\b/, /\bnvidia\b/,
    /\bdocker\b.*\b(install|run)\b/,
    /\bsystemctl\b/,
    /\bnginx\b/, /\bredis\b/, /\bpostgresql\b/, /\bmysql\b/, /\bmongodb\b/,
    /\bsdkman\b/,
    /\bgcc\b.*\b(install)\b/, /\bcmake\b/,
    /\brust\b.*\b(install)\b/, /\bcargo\b/,
    /\bnode\b.*\b(install)\b/,  // apt install node (not pip install)
    /\bR\s+.*\b(install)\b/i,
  ]
  for (const pattern of heavyPatterns) {
    if (pattern.test(lower)) return false
  }

  // Check instruction for Docker-only path patterns (BugSwarm CI paths, /opt/ tool installs)
  if (instruction) {
    const dockerPaths = [/\/home\/\w+\/build\//, /\/opt\/(?!homebrew)\w+\//]
    for (const p of dockerPaths) {
      if (p.test(instruction)) return false
    }
  }

  return true
}

/** Rewrite Docker-style absolute paths to relative paths in prompts */
function rewritePromptPaths(text: string): string {
  return text
    .replace(/\/root\//g, "")
    .replace(/\/app\//g, "")
    .replace(/\/workspace\//g, "")
    .replace(/\/home\/github\//g, "")
    .replace(/\/home\/travis\//g, "")
}

/** Rewrite paths in test code.
 *  Preserves the original quote character to avoid mismatched quotes
 *  (e.g. '/root/foo' must become 'foo', not "foo').
 */
function rewriteTestPaths(code: string): string {
  // Use a capture group for the quote so the replacement keeps the same quote style
  const dockerPrefixes = ["\\/root\\/", "\\/app\\/", "\\/workspace\\/", "\\/home\\/github\\/", "\\/home\\/travis\\/"]
  let result = code
  for (const prefix of dockerPrefixes) {
    // Bare string: '/root/foo' → 'foo'  or  "/root/foo" → "foo"
    result = result.replace(new RegExp(`(["'])${prefix}`, "g"), "$1")
    // Path() call: Path('/root/foo') → Path('foo')
    result = result.replace(new RegExp(`Path\\((["'])${prefix}`, "g"), "Path($1")
  }
  // Also handle paths constructed with f-strings or .format (no quotes involved)
  return result
    .replace(/\/root(?=\/|\b)/g, ".")
    .replace(/\/app(?=\/|\b)/g, ".")
    .replace(/\/workspace(?=\/|\b)/g, ".")
    .replace(/\/home\/github(?=\/|\b)/g, ".")
    .replace(/\/home\/travis(?=\/|\b)/g, ".")
}

/** Strip import lines for modules already provided by the wrapper */
function stripRedundantImports(code: string): string {
  const wrapperModules = new Set(["json", "math", "os", "sys", "traceback", "collections", "struct", "re", "pathlib"])
  return code.split("\n").map(line => {
    // Match "import X" or "from X import ..."
    const importMatch = line.match(/^import\s+([\w,\s]+)/)
    const fromMatch = line.match(/^from\s+([\w.]+)\s+import/)
    if (importMatch) {
      const modules = importMatch[1]!.split(",").map(m => m.trim())
      const remaining = modules.filter(m => !wrapperModules.has(m))
      if (remaining.length === 0) return "# " + line  // comment out
      if (remaining.length < modules.length) return "import " + remaining.join(", ")
    }
    if (fromMatch && wrapperModules.has(fromMatch[1]!.split(".")[0]!)) {
      // "from os import ..." or "from pathlib import Path" — keep these, they don't conflict
    }
    return line
  }).join("\n")
}

/** Convert test_outputs.py to grade.py format */
function convertTestToGrade(testCode: string): string {
  const rewritten = stripRedundantImports(rewriteTestPaths(testCode))

  // We exec the test code at module scope (not inside grade()) to avoid
  // local variable scoping issues with imports.
  return `import collections
import json
import math
import os
import re
import struct
import sys
import traceback
from pathlib import Path

# --- Begin inlined test code (module scope) ---
# Original imports stripped if redundant. Path references rewritten.

${rewritten}

# --- End inlined test code ---

def grade(transcript, workspace_path):
    """Grade function wrapping SkillsBench test_outputs.py"""
    original_dir = os.getcwd()
    os.chdir(workspace_path)

    scores = {}

    try:
        _test_funcs = {}

        # Discover test functions and classes from module scope
        for _name, _obj in dict(globals()).items():
            if _name.startswith("test_") and callable(_obj):
                _test_funcs[_name] = _obj
            elif isinstance(_obj, type) and _name.startswith("Test"):
                try:
                    _inst = _obj()
                    for _method_name in sorted(dir(_inst)):
                        if _method_name.startswith("test_"):
                            _test_funcs[f"{_name}.{_method_name}"] = getattr(_inst, _method_name)
                except Exception:
                    pass

        for _name, _func in sorted(_test_funcs.items()):
            try:
                _func()
                scores[_name] = 1.0
            except Exception:
                scores[_name] = 0.0

    except Exception as e:
        scores["_import_error"] = 0.0

    os.chdir(original_dir)
    return scores
`
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces)
  return text.split("\n").map(line => line.length > 0 ? prefix + line : line).join("\n")
}

/** List fixture files in environment/ (everything except Dockerfile and skills/) */
async function listFixtureFiles(envDir: string): Promise<string[]> {
  const result: string[] = []

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(envDir, { withFileTypes: true })
  } catch { return result }

  for (const entry of entries) {
    // Skip Dockerfile, skills dir, and hidden files
    if (entry.name === "Dockerfile" || entry.name === "skills" || entry.name.startsWith(".")) continue

    if (entry.isFile()) {
      result.push(entry.name)
    } else if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subFiles = await listFixtureFilesRecursive(path.join(envDir, entry.name), entry.name)
      result.push(...subFiles)
    }
  }

  return result
}

async function listFixtureFilesRecursive(dir: string, prefix: string): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = `${prefix}/${entry.name}`
    if (entry.isFile()) {
      result.push(relPath)
    } else if (entry.isDirectory()) {
      result.push(...await listFixtureFilesRecursive(path.join(dir, entry.name), relPath))
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Import Entry Point
// ---------------------------------------------------------------------------

export async function importSkillsBench(
  skillsbenchDir: string,
  opts?: { excludedTasks?: string[]; dryRun?: boolean },
): Promise<ImportResult> {
  const tasksDir = path.join(skillsbenchDir, "tasks")
  const excluded = new Set(opts?.excludedTasks ?? [])

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  // --- Step 1: Extract and deduplicate skills ---
  log.info("Step 1: Extracting skills...")
  const { skills: skillMap, collisions: skillCollisions } = await extractAllSkills(skillsbenchDir)

  // Build a lookup: original skill name → actual ID in registry (handles collisions)
  // For each task, we need to know which skill IDs its skills mapped to
  const skillNameToId = new Map<string, string>()
  for (const [id, info] of skillMap) {
    // For the canonical entry, map name → id
    if (!skillNameToId.has(info.name)) {
      skillNameToId.set(info.name, id)
    }
  }

  // --- Step 2: Parse all task.toml files ---
  log.info("Step 2: Parsing task metadata...")
  const taskTomlMap = new Map<string, TaskToml>()
  const taskDirs = await readdir(tasksDir, { withFileTypes: true })

  for (const entry of taskDirs) {
    if (!entry.isDirectory()) continue
    try {
      const tomlContent = await Bun.file(path.join(tasksDir, entry.name, "task.toml")).text()
      taskTomlMap.set(entry.name, parseTaskToml(tomlContent))
    } catch {
      log.debug(`No task.toml for ${entry.name}`)
    }
  }

  // --- Step 3: Write skills (unless dry run) ---
  let skillsImported = 0
  if (!opts?.dryRun) {
    log.info("Step 3: Writing skills...")
    skillsImported = await writeSkills(skillMap, taskTomlMap)
  } else {
    skillsImported = skillMap.size
    log.info(`Step 3: [dry-run] Would write ${skillsImported} skills`)
  }

  // --- Step 4: Convert and write tasks ---
  log.info("Step 4: Converting tasks...")

  for (const taskEntry of taskDirs.filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskName = taskEntry.name
    if (excluded.has(taskName)) {
      skipped.push(`${taskName} (excluded)`)
      continue
    }

    try {
      const taskDir = path.join(tasksDir, taskName)
      const toml = taskTomlMap.get(taskName)
      if (!toml) {
        skipped.push(`${taskName} (no task.toml)`)
        continue
      }

      // Read instruction.md
      let instruction: string
      try {
        instruction = await Bun.file(path.join(taskDir, "instruction.md")).text()
      } catch {
        skipped.push(`${taskName} (no instruction.md)`)
        continue
      }

      // Read Dockerfile for hostReady detection
      let hostReady = true
      try {
        const dockerfile = await Bun.file(path.join(taskDir, "environment", "Dockerfile")).text()
        hostReady = detectHostReady(dockerfile, instruction)
      } catch {
        // No Dockerfile — still check instruction for Docker-only paths
        hostReady = detectHostReady("", instruction)
      }

      // Determine skill bindings (only dirs with SKILL.md)
      const skillsPath = path.join(taskDir, "environment", "skills")
      let skillBinding: string | string[] | null = null
      try {
        const skillDirs = await readdir(skillsPath, { withFileTypes: true })
        const validSkillNames: string[] = []
        for (const d of skillDirs) {
          if (!d.isDirectory()) continue
          // Only include if SKILL.md exists
          try {
            await stat(path.join(skillsPath, d.name, "SKILL.md"))
            validSkillNames.push(d.name)
          } catch { /* no SKILL.md, skip */ }
        }
        if (validSkillNames.length === 1) {
          skillBinding = skillNameToId.get(validSkillNames[0]!) ?? validSkillNames[0]!
        } else if (validSkillNames.length > 1) {
          skillBinding = validSkillNames.map(n => skillNameToId.get(n) ?? n)
        }
      } catch { /* no skills directory */ }

      // Convert test_outputs.py → grade.py
      let gradeCode: string | undefined
      try {
        const testCode = await Bun.file(path.join(taskDir, "tests", "test_outputs.py")).text()
        gradeCode = convertTestToGrade(testCode)
      } catch {
        log.debug(`No test_outputs.py for ${taskName}`)
      }

      // Build eval criteria
      const eval_: EvalCriterion[] = gradeCode
        ? [{ method: "custom" as const, evaluatorId: "python-grade", id: "custom", name: "Automated Grade", weight: 1.0, payload: gradeCode }]
        : [{ method: "llm-judge" as const, rubric: "Evaluate whether the agent successfully completed the task.", maxScore: 1.0, id: "llm-judge", name: "Quality Judge", weight: 1.0 }]

      // Difficulty mapping (normalize "middle" → "medium")
      const rawDifficulty = toml.metadata?.difficulty
      const difficulty = rawDifficulty === "middle" ? "medium" as const
        : (rawDifficulty as "easy" | "medium" | "hard" | undefined)

      // Build the BenchTask
      const benchTask: BenchTask = {
        id: taskName,
        name: taskName.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        prompt: rewritePromptPaths(instruction),
        eval: eval_,
        timeoutMs: (toml.agent?.timeout_sec ?? 300) * 1000,
        maxSteps: 50,
        category: toml.metadata?.category ?? "general",
        gradingType: "automated",
        skill: skillBinding,
        hostReady,
        difficulty,
        origin: {
          source: "skillsbench",
          repo: "https://github.com/benchflow-ai/skillsbench",
          file: `tasks/${taskName}/`,
          importedAt: new Date().toISOString(),
        },
      }

      if (opts?.dryRun) {
        imported.push(`${taskName} (dry-run, skills=${Array.isArray(skillBinding) ? skillBinding.length : skillBinding ? 1 : 0}, hostReady=${hostReady})`)
        continue
      }

      // Write task
      const outDir = await writeTask(benchTask, {})

      // Copy fixture files from environment/
      const envDir = path.join(taskDir, "environment")
      const fixtureFiles = await listFixtureFiles(envDir)
      for (const relPath of fixtureFiles) {
        try {
          const srcPath = path.join(envDir, relPath)
          await addFixtureFile(taskName, relPath, srcPath, {})
        } catch (err) {
          log.debug(`Failed to copy fixture ${relPath}: ${err}`)
        }
      }

      // Also copy test expected data from tests/ (e.g. expected.json)
      try {
        const testsDir = path.join(taskDir, "tests")
        const testFiles = await readdir(testsDir, { withFileTypes: true })
        for (const f of testFiles) {
          if (f.isFile() && f.name !== "test.sh" && f.name !== "test_outputs.py" && f.name !== "__pycache__") {
            await addFixtureFile(taskName, f.name, path.join(testsDir, f.name), {})
          }
        }
      } catch { /* no tests dir */ }

      imported.push(`${taskName} -> ${outDir}`)
      log.debug(`Imported: ${taskName}`)
    } catch (err) {
      errors.push(`${taskName}: ${err}`)
    }
  }

  log.info(`Imported ${imported.length} tasks, skipped ${skipped.length}, errors ${errors.length}`)
  return { imported, skipped, errors, skillsImported, skillCollisions }
}
