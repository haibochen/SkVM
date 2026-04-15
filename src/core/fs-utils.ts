import path from "node:path"
import { mkdir, readdir, copyFile } from "node:fs/promises"

export interface CopyDirOptions {
  /** Return true to skip an entry (matched by its basename). */
  skip?: (name: string, isDirectory: boolean) => boolean
}

/** Recursively copy a directory tree. */
export async function copyDirRecursive(
  src: string,
  dest: string,
  opts: CopyDirOptions = {},
): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (opts.skip?.(entry.name, entry.isDirectory())) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, opts)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
    }
  }
}

const SKILL_BUNDLE_EXCLUDED = new Set([
  "LICENSE.txt",
  "_meta.json",
  ".git",
  ".DS_Store",
])

/**
 * Copy a skill bundle folder, skipping VCS metadata, OS junk, and a small
 * allowlist of skill-bundle metadata. All other entries — including hidden
 * bundle directories like `.learnings/` — are copied verbatim. A blanket
 * `name.startsWith(".")` skip silently lost runtime-state files for skills
 * that depend on them (e.g. self-improving-agent).
 */
export async function copySkillDir(src: string, dest: string): Promise<void> {
  await copyDirRecursive(src, dest, {
    skip: (name) => SKILL_BUNDLE_EXCLUDED.has(name),
  })
}
