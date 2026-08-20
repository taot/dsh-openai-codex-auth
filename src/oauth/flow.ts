/**
 * OpenAI Codex (ChatGPT Plus/Pro) OAuth flow: browser (interactive) and
 * device-code (headless) login, token exchange, and refresh. Runs Host-side
 * only — the browser half merely instructs the Host to run these.
 *
 * @module dsh-openai-codex/oauth/flow
 */

import {
  OPENAI_AUTHORIZE_URL,
  OPENAI_BROWSER_REDIRECT_URI,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_SCOPE,
  OPENAI_DEVICE_CODE_TIMEOUT_SECONDS,
  OPENAI_DEVICE_CODE_URL,
  OPENAI_DEVICE_REDIRECT_URI,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_DEVICE_VERIFICATION_URI,
  OPENAI_TOKEN_URL,
} from './constants.ts'
import { generatePKCE, createOAuthState } from './pkce.ts'
import { getChatGptAccountId } from './jwt.ts'
import { startCallbackServer } from './callback-server.ts'
import type { DeviceFlowSession, OAuthCredential, TokenResponse } from './types.ts'

/** How a client is identified by OpenAI (surfaced in the authorize page). */
export const OPENAI_ORIGINATOR = 'deepseek-harness'

/** Parse an authorization code from pasted text (a URL, `code#state`, or a bare code). */
export function parseAuthorizationInput(input: string): { code?: string | undefined; state?: string | undefined } {
  const value = input.trim()
  const missing: { code?: string | undefined; state?: string | undefined } = {}
  if (value.length === 0) return missing
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Not a URL — fall through.
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }
  return { code: value }
}

/** Abortable sleep (resolves immediately on abort by rejecting with a message). */
function abortableSleep(ms: number, signal: AbortSignal, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(message))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new Error(message))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readTokenResponse(response: Response, operation: 'exchange' | 'refresh'): Promise<TokenResponse> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex token ${operation} failed (${String(response.status)}): ${text || response.statusText}`)
  }
  const json = await response.json() as Partial<TokenResponse>
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`)
  }
  return json as TokenResponse
}

function credentialFromToken(token: TokenResponse): OAuthCredential {
  const accountId = getChatGptAccountId(token.access_token)
  if (accountId === undefined) {
    throw new Error('Failed to extract the ChatGPT account id from the access token')
  }
  return {
    type: 'oauth',
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId,
  }
}

/**
 * Build the interactive authorize URL for a fresh PKCE pair.
 * @returns the verifier, state, and authorize URL.
 */
export async function createAuthorizationFlow(): Promise<{ verifier: string; state: string; url: string }> {
  const { verifier, challenge } = await generatePKCE()
  const state = createOAuthState()
  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID)
  url.searchParams.set('redirect_uri', OPENAI_BROWSER_REDIRECT_URI)
  url.searchParams.set('scope', OPENAI_CODEX_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', OPENAI_ORIGINATOR)
  return { verifier, state, url: url.toString() }
}

/**
 * Run the interactive browser OAuth flow.
 * @param openBrowser - best-effort opener for the authorize URL; may be a no-op (the URL is also returned).
 * @param signal - abort signal; the local server is torn down on abort.
 * @returns the acquired OAuth credential.
 */
export async function browserOAuthLogin(
  openBrowser: (url: string) => void,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const { verifier, state, url } = await createAuthorizationFlow()
  const server = await startCallbackServer(state)
  const onAbort = (): void => server.close()
  if (signal.aborted) onAbort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    openBrowser(url)
    const result = await server.waitForCode()
    if (result === null) throw new Error('OpenAI Codex login cancelled')
    return exchangeAuthorizationCode(result.code, verifier, OPENAI_BROWSER_REDIRECT_URI, signal)
  } finally {
    signal.removeEventListener('abort', onAbort)
    server.close()
  }
}

/** Exchange an authorization code for tokens. */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal,
  })
  return credentialFromToken(await readTokenResponse(response, 'exchange'))
}

/** Refresh an expired access token using the refresh grant. */
export async function refreshOpenAICodexToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
    signal,
  })
  return credentialFromToken(await readTokenResponse(response, 'refresh'))
}

/** Begin a device-code flow and return the user-facing session (user code + verification URI). */
export async function beginDeviceFlow(signal: AbortSignal): Promise<DeviceFlowSession> {
  const response = await fetch(OPENAI_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('OpenAI Codex device-code login is not enabled. Use browser login instead.')
    }
    const body = await response.text().catch(() => '')
    throw new Error(`OpenAI Codex device-code request failed (${String(response.status)}): ${body}`)
  }
  const json = await response.json() as { device_auth_id?: string; user_code?: string; interval?: number | string } | null
  const intervalSeconds = typeof json?.interval === 'string'
    ? Number(json.interval.trim())
    : json?.interval
  if (!json?.device_auth_id || !json.user_code || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error(`Invalid OpenAI Codex device-code response: ${JSON.stringify(json)}`)
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    verificationUri: OPENAI_DEVICE_VERIFICATION_URI,
    expiresInSeconds: OPENAI_DEVICE_CODE_TIMEOUT_SECONDS,
    intervalSeconds,
  }
}

type DevicePollResult =
  | { status: 'pending' }
  | { status: 'complete'; credential: OAuthCredential }
  | { status: 'failed'; message: string }

/** Poll the device-code token endpoint once; returns a credentialed completion on success. */
export async function pollDeviceFlowOnce(session: DeviceFlowSession, signal: AbortSignal): Promise<DevicePollResult> {
  const response = await fetch(OPENAI_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: session.deviceAuthId,
      user_code: session.userCode,
    }),
    signal,
  })
  if (response.ok) {
    const json = await response.json() as { authorization_code?: string; code_verifier?: string } | null
    if (json?.authorization_code && json.code_verifier) {
      const credential = await exchangeAuthorizationCode(
        json.authorization_code,
        json.code_verifier,
        OPENAI_DEVICE_REDIRECT_URI,
        signal,
      )
      return { status: 'complete', credential }
    }
    return { status: 'failed', message: `Invalid OpenAI Codex device token response: ${JSON.stringify(json)}` }
  }
  if (response.status === 403 || response.status === 404) return { status: 'pending' }
  const body = await response.text().catch(() => '')
  let errorCode: unknown
  try {
    const json = JSON.parse(body) as { error?: string | { code?: string } } | null
    const error = json?.error
    errorCode = typeof error === 'object' ? error?.code : error
  } catch {
    // Not JSON — fall through.
  }
  if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' }
  if (errorCode === 'slow_down') return { status: 'pending' }
  return { status: 'failed', message: `OpenAI Codex device auth failed (${String(response.status)}): ${body}` }
}

/**
 * Poll a device-code flow to completion.
 * @param session - an active device-code session.
 * @param poll - one-shot poll callback (defaults to {@link pollDeviceFlowOnce}).
 * @param signal - abort signal.
 * @returns the completed OAuth credential.
 */
export async function pollDeviceFlow(
  session: DeviceFlowSession,
  poll: (session: DeviceFlowSession, signal: AbortSignal) => Promise<DevicePollResult>,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const deadline = Date.now() + session.expiresInSeconds * 1000
  const intervalMs = Math.max(1000, Math.floor(session.intervalSeconds * 1000))
  const cancelMessage = 'OpenAI Codex device login cancelled'
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error(cancelMessage)
    const result = await poll(session, signal)
    if (result.status === 'complete') return result.credential
    if (result.status === 'failed') throw new Error(result.message)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await abortableSleep(Math.min(intervalMs, remainingMs), signal, cancelMessage)
  }
  throw new Error('OpenAI Codex device flow timed out')
}

/** The callback host used to open the interactive authorize URL (best-effort). */
export const BROWSER_REDIRECT_URI = OPENAI_BROWSER_REDIRECT_URI
