import { test, expect, describe } from "bun:test"
import {
  ProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderAuthError,
  isProviderError,
  isRetryableStatus,
  looksLikeNetworkError,
} from "../../src/providers/errors.ts"

describe("ProviderError classification", () => {
  test("ProviderAuthError is non-retryable", () => {
    const e = new ProviderAuthError("bad key", "openrouter")
    expect(e.retryable).toBe(false)
    expect(isProviderError(e)).toBe(true)
    expect(e.provider).toBe("openrouter")
  })

  test("ProviderNetworkError is retryable", () => {
    const e = new ProviderNetworkError("socket closed", "openai")
    expect(e.retryable).toBe(true)
    expect(isProviderError(e)).toBe(true)
  })

  test("ProviderHttpError 429 is retryable", () => {
    const e = new ProviderHttpError("rate limit", "openrouter", 429, "too many")
    expect(e.retryable).toBe(true)
    expect(e.status).toBe(429)
  })

  test("ProviderHttpError 404 is non-retryable", () => {
    const e = new ProviderHttpError("not found", "openrouter", 404)
    expect(e.retryable).toBe(false)
  })

  test("isProviderError is false for plain Error", () => {
    expect(isProviderError(new Error("generic"))).toBe(false)
    expect(isProviderError("string")).toBe(false)
    expect(isProviderError(undefined)).toBe(false)
  })
})

describe("isRetryableStatus", () => {
  test("5xx status codes retry", () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(502)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(504)).toBe(true)
  })

  test("429 retries", () => {
    expect(isRetryableStatus(429)).toBe(true)
  })

  test("4xx client errors don't retry", () => {
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(403)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
  })
})

describe("looksLikeNetworkError", () => {
  test("matches fetch-failed variants", () => {
    expect(looksLikeNetworkError(new Error("fetch failed"))).toBe(true)
    expect(looksLikeNetworkError(new Error("ECONNRESET"))).toBe(true)
    expect(looksLikeNetworkError(new Error("socket hang up"))).toBe(true)
  })

  test("rejects non-network errors", () => {
    expect(looksLikeNetworkError(new Error("JSON parse error"))).toBe(false)
    expect(looksLikeNetworkError("not an error")).toBe(false)
  })
})
