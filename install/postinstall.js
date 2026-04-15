#!/usr/bin/env node
// npm postinstall hook: download the matching skvm binary from GitHub Releases.
//
// Runs in two contexts and must not break either:
//   1. Real install (`npm i -g @ipads-skvm/skvm`): download binary into bin/
//   2. Dev repo (`bun install` or `npm install` at the source tree): no-op
//
// Detection: dev repo has src/index.ts next to package.json; installed package does not.
//
// Opt out: SKVM_SKIP_POSTINSTALL=1 or SKVM_SKIP_OPENCODE=1 (the latter skips only
// the bundled opencode step, not the skvm binary — but this is the entry point for
// both, so both env vars gate this script).
//
// Windows is intentionally not supported in this round (plan §1.3 targets darwin/linux only).

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import https from "node:https"
import os from "node:os"

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, "..")

// ---------------- dev-repo guard ----------------
if (existsSync(path.join(pkgRoot, "src", "index.ts"))) {
  console.log("skvm postinstall: dev repo detected (src/index.ts present), skipping binary download")
  process.exit(0)
}

// ---------------- opt-out ----------------
if (process.env.SKVM_SKIP_POSTINSTALL === "1") {
  console.log("skvm postinstall: SKVM_SKIP_POSTINSTALL=1, skipping")
  process.exit(0)
}

// ---------------- platform detection ----------------
const TARGETS = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
}

const platform = process.platform
const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
const targetKey = `${platform}-${arch}`
const target = TARGETS[targetKey]

if (!target) {
  console.error(
    `skvm postinstall: unsupported platform ${targetKey}. ` +
      `Supported: ${Object.keys(TARGETS).join(", ")}. ` +
      `If you want to run skvm here, install from source: https://github.com/SJTU-IPADS/SkVM`,
  )
  process.exit(1)
}

// ---------------- release host + version ----------------
const host = JSON.parse(readFileSync(path.join(pkgRoot, "install", "release-host.json"), "utf8"))
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"))
const version = pkg.version
const owner = host.owner
const repo = host.repo

// ---------------- download ----------------
const binDir = path.join(pkgRoot, "bin")
mkdirSync(binDir, { recursive: true })
const tmpDir = path.join(os.tmpdir(), `skvm-postinstall-${process.pid}`)
mkdirSync(tmpDir, { recursive: true })

const tarballName = `skvm-v${version}-${target}.tar.gz`
const tarballUrl = `https://github.com/${owner}/${repo}/releases/download/v${version}/${tarballName}`
const sumUrl = `${tarballUrl}.sha256`
const tmpTarball = path.join(tmpDir, tarballName)

function fetchToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "skvm-postinstall" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve(fetchToFile(res.headers.location, destPath))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → ${res.statusCode}`))
        return
      }
      const file = createWriteStream(destPath)
      res.pipe(file)
      file.on("finish", () => file.close(() => resolve()))
      file.on("error", reject)
    })
    req.on("error", reject)
  })
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "skvm-postinstall" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve(fetchText(res.headers.location))
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → ${res.statusCode}`))
        return
      }
      let body = ""
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => resolve(body))
    })
    req.on("error", reject)
  })
}

console.log(`skvm postinstall: downloading ${tarballName}…`)
try {
  await fetchToFile(tarballUrl, tmpTarball)

  const expectedSum = (await fetchText(sumUrl)).trim().split(/\s+/)[0]
  const actualSum = createHash("sha256").update(readFileSync(tmpTarball)).digest("hex")
  if (expectedSum && expectedSum !== actualSum) {
    throw new Error(`sha256 mismatch: expected ${expectedSum}, got ${actualSum}`)
  }

  // Extract using system tar. Bundled opencode (if present in the tarball under
  // vendor/opencode/) is extracted too. For now we extract everything and let
  // the tar lay out: bin/skvm, vendor/, skills/.
  const res = spawnSync("tar", ["-xzf", tmpTarball, "-C", pkgRoot], { stdio: "inherit" })
  if (res.status !== 0) throw new Error(`tar extraction failed (exit ${res.status})`)

  const binaryPath = path.join(binDir, "skvm")
  if (!existsSync(binaryPath)) {
    throw new Error(`binary not found at ${binaryPath} after extraction`)
  }
  chmodSync(binaryPath, 0o755)

  console.log(`skvm postinstall: installed skvm v${version} for ${target}`)
} catch (err) {
  console.error(`skvm postinstall: ${err.message}`)
  console.error(
    `If you are behind a proxy or air-gapped, re-run with SKVM_SKIP_POSTINSTALL=1 ` +
      `and install the binary manually from https://github.com/${owner}/${repo}/releases`,
  )
  process.exit(1)
}

// -------- opencode bundling (plan §1.8) --------
// Keep this in sync with install/install.sh — same version, same URL pattern.
if (process.env.SKVM_SKIP_OPENCODE !== "1") {
  try {
    await installOpencode()
  } catch (err) {
    console.warn(
      `skvm postinstall: opencode bundling failed (${err.message}); ` +
        `jit-optimize will require a global opencode or adapters.opencode config`,
    )
  }
}

async function installOpencode() {
  const oc = JSON.parse(readFileSync(path.join(pkgRoot, "install", "opencode-version.json"), "utf8"))
  const ocVersion = oc.version
  const ocTag = ocVersion.startsWith("v") ? ocVersion : `v${ocVersion}`
  const ocOwner = oc.owner || "anomalyco"
  const ocRepo = oc.repo || "opencode"
  const assetDef = oc.assets?.[target]
  if (!assetDef) {
    throw new Error(`no bundled opencode asset defined for target ${target}`)
  }
  const ocAssetName = assetDef.name
  const ocFormat = assetDef.format
  const ocUrl = `https://github.com/${ocOwner}/${ocRepo}/releases/download/${ocTag}/${ocAssetName}`
  const vendorRoot = path.join(pkgRoot, "vendor", "opencode")
  const versionDir = path.join(vendorRoot, ocTag)
  const profileRoot = path.join(vendorRoot, "profile")
  const binPath = path.join(versionDir, "bin", "opencode")

  const { mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, lstatSync } =
    await import("node:fs")

  if (existsSync(binPath)) {
    console.log(`skvm postinstall: bundled opencode ${ocTag} already present`)
  } else {
    console.log(`skvm postinstall: downloading bundled opencode ${ocTag}`)
    mkdirSync(versionDir, { recursive: true })
    const ocTmp = path.join(tmpDir, ocAssetName)
    await fetchToFile(ocUrl, ocTmp)

    const expected = oc.sha256?.[target]
    if (expected) {
      const actual = createHash("sha256").update(readFileSync(ocTmp)).digest("hex")
      if (expected !== actual) {
        throw new Error(`opencode sha256 mismatch: expected ${expected}, got ${actual}`)
      }
    }

    // Extract to a staging dir, then relocate the flat `opencode` binary into
    // bin/opencode. Mirrors install.sh's fallback (Codex review P3) so both
    // paths accept the same upstream tarball layouts.
    const stage = mkdtempSync(path.join(tmpDir, "opencode-extract-"))
    let extractRes
    if (ocFormat === "zip") {
      extractRes = spawnSync("unzip", ["-q", ocTmp, "-d", stage], { stdio: "inherit" })
    } else if (ocFormat === "tar.gz") {
      extractRes = spawnSync("tar", ["-xzf", ocTmp, "-C", stage], { stdio: "inherit" })
    } else {
      throw new Error(`unknown opencode archive format: ${ocFormat}`)
    }
    if (extractRes.status !== 0) {
      throw new Error(`opencode extraction failed (exit ${extractRes.status})`)
    }

    // Locate the extracted `opencode` binary: prefer <stage>/opencode, else
    // search recursively (handles both the current flat-single-binary layout
    // and any future wrapped layout).
    const candidate = path.join(stage, "opencode")
    let found = existsSync(candidate) ? candidate : null
    if (!found) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            const hit = walk(p)
            if (hit) return hit
          } else if (entry.isFile() && entry.name === "opencode") {
            return p
          }
        }
        return null
      }
      found = walk(stage)
    }
    if (!found) {
      throw new Error("opencode binary not found in extracted archive")
    }

    mkdirSync(path.join(versionDir, "bin"), { recursive: true })
    renameSync(found, binPath)
    chmodSync(binPath, 0o755)
    rmSync(stage, { recursive: true, force: true })
  }

  // Update the "current" symlink used by src/adapters/opencode.ts resolver
  const currentLink = path.join(vendorRoot, "current")
  try { if (lstatSync(currentLink)) unlinkSync(currentLink) } catch {}
  symlinkSync(ocTag, currentLink, "dir")

  // Create isolated profile dirs (preserve contents on upgrades)
  for (const sub of ["config", "data", "state", "cache", "plugins", "skills"]) {
    mkdirSync(path.join(profileRoot, sub), { recursive: true })
  }

  console.log(`skvm postinstall: bundled opencode ready at ${binPath}`)
  console.log(`  Profile root (isolated from global opencode): ${profileRoot}`)
}
