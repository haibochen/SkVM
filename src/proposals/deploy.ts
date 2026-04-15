/**
 * Deploy an accepted proposal round to a skill directory.
 *
 * Copies every file from {proposal}/round-{N}/ into the target skill folder,
 * backing up any files that would be overwritten into a .bak.{timestamp} file.
 */

import path from "node:path"
import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { loadProposal, updateStatus, roundDirPath } from "./storage.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("proposals-deploy")

export interface DeployResult {
  targetDir: string
  deployedRound: number
  filesDeployed: string[]
  filesBackedUp: string[]
}

export interface DeployOptions {
  /** Target skill directory; defaults to proposal.meta.skillDir */
  targetDir?: string
  /** Which round to deploy; defaults to proposal.meta.bestRound */
  round?: number
}

export async function deployProposal(id: string, opts: DeployOptions = {}): Promise<DeployResult> {
  const proposal = await loadProposal(id)
  // Gate BEFORE touching the live skill folder. `updateStatus` has a matching
  // guard, but it only fires after every file has already been copied — too
  // late to prevent overwriting the live skill with a round-0 snapshot.
  if (proposal.meta.status === "infra-blocked") {
    throw new Error(
      `Proposal ${id} is infra-blocked — refusing to deploy. ` +
      `Its rounds are not real optimizations; rerun jit-optimize after fixing the underlying infra issue.`,
    )
  }
  const target = opts.targetDir ?? proposal.meta.skillDir
  const round = opts.round ?? proposal.meta.bestRound
  const src = roundDirPath(proposal.dir, round)

  // Enumerate files to deploy
  const entries = await readdir(src, { withFileTypes: true, recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const deployed: string[] = []
  const backedUp: string[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath ?? src, entry.name)
    const rel = path.relative(src, full)
    if (rel.startsWith(".") || rel.includes("/.")) continue

    const dest = path.join(target, rel)

    // Backup existing file if present
    const existing = Bun.file(dest)
    if (await existing.exists()) {
      const backup = `${dest}.bak.${ts}`
      await copyFile(dest, backup)
      backedUp.push(path.relative(target, backup))
    }

    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(full, dest)
    deployed.push(rel)
  }

  await updateStatus(id, "accepted", round)
  log.info(`Deployed proposal ${id} round ${round} → ${target} (${deployed.length} file(s))`)

  return {
    targetDir: target,
    deployedRound: round,
    filesDeployed: deployed,
    filesBackedUp: backedUp,
  }
}
