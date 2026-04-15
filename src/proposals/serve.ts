/**
 * Local HTTP server for `skvm proposals serve`.
 *
 * Exposes a JSON API over the same storage helpers used by the CLI. Bound to
 * 127.0.0.1 by default — accept/reject mutate files on disk, so we don't want
 * this on an external interface without auth.
 *
 * Routes:
 *   GET  /                          → editorial HTML shell (from frontend.ts)
 *   GET  /api/proposals             → all proposals with derived summary
 *   GET  /api/proposal/diff?id=&round=
 *   POST /api/proposal/accept       body: {id, round?}
 *   POST /api/proposal/reject       body: {id}
 *   GET  /api/health                → {ok:true}
 */

import { listProposals, loadProposal, updateStatus, proposalDirFromId } from "./storage.ts"
import { summarizeProposal } from "./summary.ts"
import { diffProposalRound } from "./diff.ts"
import { deployProposal } from "./deploy.ts"
import { renderFrontend } from "./frontend.ts"
import { createLogger } from "../core/logger.ts"

const log = createLogger("proposals-serve")

export interface ServeOptions {
  port: number
  host: string
}

// ---------------------------------------------------------------------------
// Payload shapes — kept minimal, client mirrors these with any-typed access.
// ---------------------------------------------------------------------------

async function buildProposalsPayload() {
  const items = await listProposals({})
  const loaded = await Promise.all(items.map((s) => loadProposal(s.id)))
  return {
    proposals: loaded.map((p) => ({
      id: p.id,
      meta: p.meta,
      summary: summarizeProposal(p),
    })),
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  })
}

function bad(status: number, message: string): Response {
  return json({ ok: false, error: message }, { status })
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleGetProposals(): Promise<Response> {
  const payload = await buildProposalsPayload()
  return json(payload)
}

async function handleGetDiff(url: URL): Promise<Response> {
  const id = url.searchParams.get("id")
  const roundParam = url.searchParams.get("round")
  if (!id) return bad(400, "missing id")
  if (!roundParam) return bad(400, "missing round")
  const round = parseInt(roundParam, 10)
  if (Number.isNaN(round)) return bad(400, "round must be integer")
  if (round === 0) return json({ ok: true, unified: "", note: "baseline — no diff" })
  const result = await diffProposalRound(proposalDirFromId(id), round)
  if (!result.ok) return json({ ok: false, reason: result.reason }, { status: 200 })
  return json({ ok: true, unified: result.unified })
}

async function handlePostAccept(req: Request): Promise<Response> {
  let body: { id?: string; round?: number }
  try {
    body = (await req.json()) as { id?: string; round?: number }
  } catch {
    return bad(400, "body must be JSON")
  }
  if (!body.id) return bad(400, "missing id")
  try {
    const result = await deployProposal(body.id, { round: body.round })
    // After accept, return the fresh meta for the client to update its row.
    const updated = await loadProposal(body.id)
    return json({
      ok: true,
      deployedRound: result.deployedRound,
      filesDeployed: result.filesDeployed,
      filesBackedUp: result.filesBackedUp,
      meta: updated.meta,
    })
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

async function handlePostReject(req: Request): Promise<Response> {
  let body: { id?: string }
  try {
    body = (await req.json()) as { id?: string }
  } catch {
    return bad(400, "body must be JSON")
  }
  if (!body.id) return bad(400, "missing id")
  try {
    await updateStatus(body.id, "rejected")
    const updated = await loadProposal(body.id)
    return json({ ok: true, meta: updated.meta })
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Top-level request router
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  try {
    if (req.method === "GET" && p === "/") {
      return new Response(renderFrontend(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    }
    if (req.method === "GET" && p === "/api/health") return json({ ok: true })
    if (req.method === "GET" && p === "/api/proposals") return await handleGetProposals()
    if (req.method === "GET" && p === "/api/proposal/diff") return await handleGetDiff(url)
    if (req.method === "POST" && p === "/api/proposal/accept") return await handlePostAccept(req)
    if (req.method === "POST" && p === "/api/proposal/reject") return await handlePostReject(req)
    return new Response("Not found", { status: 404 })
  } catch (err) {
    log.error(`${req.method} ${p} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    return bad(500, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RunningServer {
  url: string
  stop: () => void
}

export function startServer(opts: ServeOptions): RunningServer {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: route,
  })
  const url = `http://${opts.host}:${server.port}`
  log.info(`Listening on ${url}`)
  return {
    url,
    stop: () => server.stop(),
  }
}
