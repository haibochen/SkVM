/**
 * Guard: validates compiled skill output.
 *
 * Checks:
 * 1. Net added lines <= 50% of original
 * 2. All original code blocks preserved (exempt blocks replaced by substitution)
 * 3. Frontmatter unchanged (if present)
 */

import type { Transform } from "../core/types.ts"

export interface GuardResult {
  passed: boolean
  violations: string[]
}

export function validateGuard(
  original: string,
  compiled: string,
  transforms?: Transform[],
): GuardResult {
  const violations: string[] = []

  // 1. Length check: tiered threshold based on original size
  //    Short skills (<100 lines) get generous expansion — they need more compensation relative to their size
  //    Medium skills (100-200) get 1:1 expansion budget
  //    Long skills (>200) get tighter limits — expansion is more likely noise
  const origLines = original.split("\n").length
  const compLines = compiled.split("\n").length
  const addedLines = compLines - origLines
  const expansionFactor = origLines < 100 ? 2.0 : origLines < 200 ? 1.0 : 0.5
  const maxAdded = Math.ceil(origLines * expansionFactor)
  if (addedLines > maxAdded) {
    violations.push(
      `Length: added ${addedLines} lines (max ${maxAdded}, ${origLines} original)`
    )
  }

  // 2. Code blocks preserved: every ``` block in original should exist in compiled
  //    Exempt blocks that were replaced by substitution transforms
  const substitutionOriginals = new Set(
    (transforms ?? [])
      .filter((t) => t.type === "substitution" && t.action === "replace" && t.original)
      .map((t) => t.original!),
  )

  const origCodeBlocks = extractCodeBlocks(original)
  const compText = compiled
  for (const block of origCodeBlocks) {
    const trimmed = block.content.trim()
    if (trimmed.length <= 10) continue

    // Skip if this block is inside a section that was substituted
    const isExempt = [...substitutionOriginals].some((orig) => orig.includes(trimmed))
    if (isExempt) continue

    if (!compText.includes(trimmed)) {
      violations.push(
        `Code block missing: "${trimmed.slice(0, 60)}..."`
      )
    }
  }

  // 3. Frontmatter preserved
  const origFrontmatter = extractFrontmatter(original)
  const compFrontmatter = extractFrontmatter(compiled)
  if (origFrontmatter && origFrontmatter !== compFrontmatter) {
    violations.push("Frontmatter modified")
  }

  // 4. Heading structure preserved
  const origHeadings = extractHeadings(original)
  const compHeadings = extractHeadings(compiled)
  if (origHeadings.length !== compHeadings.length) {
    const diff = compHeadings.length - origHeadings.length
    if (diff > 0) {
      // Find added headings
      const origSet = new Set(origHeadings)
      for (const h of compHeadings) {
        if (!origSet.has(h)) {
          violations.push(`Heading added: "${h}"`)
        }
      }
    } else {
      // Find removed headings
      const compSet = new Set(compHeadings)
      for (const h of origHeadings) {
        if (!compSet.has(h)) {
          violations.push(`Heading removed: "${h}"`)
        }
      }
    }
  } else {
    for (let i = 0; i < origHeadings.length; i++) {
      if (origHeadings[i] !== compHeadings[i]) {
        violations.push(`Heading changed: "${origHeadings[i]}" -> "${compHeadings[i]}"`)
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}

interface CodeBlock {
  lang: string
  content: string
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const regex = /```(\w*)\n([\s\S]*?)```/g
  let match
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ lang: match[1] ?? "", content: match[2] ?? "" })
  }
  return blocks
}

function extractFrontmatter(text: string): string | null {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  return match ? match[1]! : null
}

function extractHeadings(text: string): string[] {
  const lines = text.split("\n")
  let inCodeBlock = false
  const headings: string[] = []
  for (const line of lines) {
    if (line.startsWith("```")) inCodeBlock = !inCodeBlock
    if (!inCodeBlock && /^#{1,6}\s+/.test(line)) {
      headings.push(line.trimEnd())
    }
  }
  return headings
}
