/**
 * Typed provider error hierarchy.
 *
 * The goal is to distinguish **infrastructure failures** (provider down,
 * network hiccup, auth misconfigured, rate limit exhausted) from **content
 * failures** (LLM produced malformed JSON, schema validation failed, tool
 * call missing). Infra failures must propagate to the loop / CLI so they
 * can fail loudly; content failures can be retried, fallen back to, or
 * scored as 0 without polluting the skill-quality signal.
 *
 * Every `LLMProvider.complete` implementation that talks to the network
 * must throw one of these on terminal failure (after internal retries are
 * exhausted). Generic `Error` escaping a provider indicates a bug.
 */

/** Base class. All provider-originating infra errors extend this. */
export class ProviderError extends Error {
  /** Underlying error, for debugging. */
  override readonly cause?: unknown
  constructor(
    message: string,
    /** Short provider identifier (e.g. "openrouter", "anthropic"). */
    readonly provider: string,
    cause?: unknown,
    /**
     * Whether retrying *might* succeed. Used by in-provider retry loops;
     * by the time a ProviderError escapes the provider, the retries have
     * already been exhausted, so higher layers should NOT re-retry.
     */
    readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = "ProviderError"
    this.cause = cause
  }
}

/** HTTP-layer failure with a status code. */
export class ProviderHttpError extends ProviderError {
  constructor(
    message: string,
    provider: string,
    readonly status: number,
    readonly body?: string,
    cause?: unknown,
  ) {
    super(message, provider, cause, isRetryableStatus(status))
    this.name = "ProviderHttpError"
  }
}

/** Socket / DNS / connection / TLS / fetch-failed class. */
export class ProviderNetworkError extends ProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause, true)
    this.name = "ProviderNetworkError"
  }
}

/** 401 / 403 / missing API key. Never retryable. */
export class ProviderAuthError extends ProviderError {
  constructor(message: string, provider: string, cause?: unknown) {
    super(message, provider, cause, false)
    this.name = "ProviderAuthError"
  }
}

/** Status codes that the provider's internal retry loop should retry. */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUS.has(status)
}

/** Type guard for any infra-origin provider error. */
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError
}

/** Substring hints suggesting `fetch()` threw a transient network error. */
const NETWORK_ERROR_HINTS = [
  "socket",
  "fetch failed",
  "network",
  "connection",
  "econnreset",
  "etimedout",
  "ehostunreach",
  "enotfound",
  "tls",
  "closed unexpectedly",
] as const

/**
 * Heuristic: does this `fetch` rejection look like a transient network error
 * (as opposed to a programmer bug or AbortError)? Used by providers to decide
 * whether to retry inside their own loop.
 */
export function looksLikeNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return NETWORK_ERROR_HINTS.some((keyword) => msg.includes(keyword))
}
