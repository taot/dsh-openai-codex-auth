/**
 * `CodexAdapter`: fetch + SSE against the OpenAI Codex Responses endpoint,
 * emitting harness StreamChunks. Transport-only: connection facts arrive
 * through a thunk resolved once per operation, the OAuth credential (access +
 * refresh) through a per-request resolver, and refresh through an injected
 * hook so the registering plugin owns validation, token persistence, and
 * credential policy.
 *
 * @module dsh-openai-codex/codex/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { OAuthCredential } from '../oauth/types.ts'
import { OPENAI_ORIGINATOR } from '../oauth/flow.ts'
import type { CodexCatalogModel } from '../oauth/models.ts'
import { buildRequestBody, wireReasoningEffort } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** Validated connection facts for one operation. */
export interface CodexConnectionOptions {
  /** Codex responses endpoint (defaults to chatgpt.com/backend-api/codex/responses). */
  baseURL: string
  /** Resolved output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when a model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly CodexCatalogModel[]
  /** Text verbosity (always present; `undefined` means provider default). */
  verbosity: 'low' | 'medium' | 'high' | undefined
  /** Default reasoning effort (always present; `undefined` means provider default). */
  reasoningEffort: string | undefined
  /** Refresh an access token at most this many ms before expiry (default 5 min). */
  refreshBeforeMs: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Resolved provider-owned retry policy. */
  retryPolicy: ResolvedRetryPolicy
  /** Strip redundant model-emitted `sandbox_permissions` from tool calls. */
  sanitizeSandboxPermissions: boolean
}

/** Constructor options: the operation-local resolution hooks the plugin owns. */
export interface CodexAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CodexConnectionOptions
  /**
   * Resolve the current OAuth credential for one request. Throws `LlmError`
   * `MISSING_CREDENTIAL` when none is stored anywhere.
   */
  resolveCredential: (connection: CodexConnectionOptions) => Promise<OAuthCredential>
  /**
   * Refresh a stored refresh token into a new credential and persist it.
   * Runs when the access token is at/near expiry; a throw clears the stored
   * credential (the adapter calls {@link clearCredential} in that case).
   */
  refreshAccessToken: (refreshToken: string, signal?: AbortSignal) => Promise<OAuthCredential>
  /**
   * Discard the stored credential when a refresh returns an unrecoverable
   * auth error, so the user must re-authenticate.
   */
  clearCredential: () => Promise<void> | void
}

const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const MEDIUM_REASONING_EFFORT = ReasoningEffortId('medium')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')

const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: LOW_REASONING_EFFORT, name: 'Low' },
  { id: MEDIUM_REASONING_EFFORT, name: 'Medium' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const

function modelInfo(provider: string, model: CodexCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

/** Map an HTTP status / provider error body to a stable LlmError code. */
function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (/quota|usage limit|insufficient_quota|out of budget|billing/i.test(detail)) return 'QUOTA_EXCEEDED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Sandbox denials in tool results name the session's active mode, e.g.
 * `not strictly wider than this call's current "workspace-write" mode`.
 */
const ACTIVE_MODE_PATTERN = /current "([a-z-]+)" mode|denied under ([a-z-]+) mode/gi

/**
 * Collect the active sandbox modes named by sandbox denials in the
 * conversation. Restating an active mode is never a valid escalation, so any
 * `sandbox_permissions` equal to one of these is stripped unconditionally;
 * other values (genuine escalations) are always preserved.
 */
function conversationActiveSandboxModes(options: GenerateOptions): string[] {
  const modes = new Set<string>()
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      for (const part of block.content) {
        if (part.type !== 'text') continue
        for (const match of part.text.matchAll(ACTIVE_MODE_PATTERN)) {
          const mode = match[1] ?? match[2]
          if (mode !== undefined) modes.add(mode.toLowerCase())
        }
      }
    }
  }
  return [...modes]
}

/**
 * The codex LLM adapter. One instance serves every model name registered under
 * the provider route (the harness model name IS the wire model name).
 */
export class CodexAdapter extends LlmAdapter {
  constructor(private readonly config: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI Codex' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: connection.reasoningEffort === undefined
          ? HIGH_REASONING_EFFORT
          : mapDefaultEffort(connection.reasoningEffort),
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for the whole request.
    const connection = this.config.options()
    const credential = await this.resolveUsableCredential(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])

    let response: Response
    try {
      const body = buildRequestBody(options, {
        reasoningEffort: connection.reasoningEffort,
        maxTokens: connection.maxTokens,
        verbosity: connection.verbosity,
      })
      response = await fetch(connection.baseURL, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${credential.access}`,
          'chatgpt-account-id': credential.accountId,
          'originator': OPENAI_ORIGINATOR,
          'OpenAI-Beta': 'responses=experimental',
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: upstream,
      })
    } catch (error: unknown) {
      if (upstream.aborted) throw new LlmError('OpenAI Codex request aborted', 'ABORTED', { cause: error })
      throw new LlmError(
        `OpenAI Codex request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `OpenAI Codex API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Swallow error-body parsing failures; status still identifies the error.
        const text = await response.text().catch(() => '')
        if (text.length > 0) message = `${message}: ${text.slice(0, 500)}`
      }
      if (httpErrorCode(response.status, providerError) === 'AUTH') {
        // A 401/403 is an unrecoverable credential problem: clear it so the
        // next request points the user at re-authentication.
        await this.config.clearCredential()
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError), { status: response.status })
    }
    if (response.body === undefined || response.body === null) {
      throw new LlmError('OpenAI Codex returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(
      parseSse(response.body, () => { /* transport activity */ }),
      {
        sandboxPermissionsPolicy: connection.sanitizeSandboxPermissions ? 'strip-redundant' : 'preserve',
        activeSandboxModes: conversationActiveSandboxModes(options),
      },
    )
  }

  /**
   * Resolve the credential, refreshing the access token if it is near expiry.
   * A failed refresh clears the stored credential and rethrows.
   */
  private async resolveUsableCredential(connection: CodexConnectionOptions): Promise<OAuthCredential> {
    const current = await this.config.resolveCredential(connection)
    if (current.expires > Date.now() + connection.refreshBeforeMs) return current
    try {
      const refreshed = await this.config.refreshAccessToken(current.refresh)
      return refreshed
    } catch (error) {
      await this.config.clearCredential()
      throw error
    }
  }
}

/** Map a configured default effort name to a ReasoningEffortId. */
function mapDefaultEffort(name: string): ReasoningEffortId {
  switch (name) {
    case 'off': return OFF_REASONING_EFFORT
    case 'low': return LOW_REASONING_EFFORT
    case 'medium': return MEDIUM_REASONING_EFFORT
    case 'max': return MAX_REASONING_EFFORT
    default: return HIGH_REASONING_EFFORT
  }
}

/** Re-export for callers that only need the effort mapping. */
export { wireReasoningEffort }
