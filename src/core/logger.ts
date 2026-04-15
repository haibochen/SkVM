import { appendFileSync } from "node:fs"

type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let currentLevel: LogLevel = "info"

export function setLogLevel(level: LogLevel) {
  currentLevel = level
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel]
}

export function formatLogMsg(level: LogLevel, component: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23)
  return `${ts} [${level.toUpperCase().padEnd(5)}] [${component}] ${msg}`
}

/** Append a line to a log file (no-op if path is null). */
export function appendLogLine(logFile: string | null | undefined, line: string) {
  if (logFile) {
    try { appendFileSync(logFile, line + "\n") } catch { /* ignore */ }
  }
}

export function createLogger(component: string) {
  return {
    debug(msg: string) {
      if (shouldLog("debug")) console.log(formatLogMsg("debug", component, msg))
    },
    info(msg: string) {
      if (shouldLog("info")) console.log(formatLogMsg("info", component, msg))
    },
    warn(msg: string) {
      if (shouldLog("warn")) console.warn(formatLogMsg("warn", component, msg))
    },
    error(msg: string) {
      if (shouldLog("error")) console.error(formatLogMsg("error", component, msg))
    },
  }
}
