/**
 * Host half of the OpenAI Codex plugin.
 *
 * Responsibilities:
 * - register the `codex` LLM provider adapter (streaming + model catalog),
 * - own the `openai-codex` user-settings namespace surfaced to the web Models
 *   page and the settings card,
 * - persist OAuth tokens through the credentials seam,
 * - serve a loopback RPC channel so the browser settings card can run the
 *   interactive/device OAuth flows and report auth status.
 *
 * @module dsh-openai-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { DEFAULT_CODEX_CONTEXT_WINDOW, DEFAULT_CODEX_MAX_TOKENS, DEFAULT_CODEX_MODELS } from './oauth/models.ts'
import type { CodexCatalogModel } from './oauth/models.ts'
import { OPENAI_CODEX_API_ENDPOINT, OPENAI_DEVICE_VERIFICATION_URI as DEVICE_VERIFICATION_FALLBACK } from './oauth/constants.ts'
import type { OAuthCredential, CodexAuthStatus, DeviceFlowSession } from './oauth/types.ts'
import {
  browserOAuthLogin,
  beginDeviceFlow,
  pollDeviceFlowOnce,
  refreshOpenAICodexToken,
} from './oauth/flow.ts'
import {
  clearStoredCredential,
  readAuthStatus,
  readStoredCredential,
  writeStoredCredential,
} from './oauth/store.ts'
import { CodexAdapter } from './codex/adapter.ts'
import type { CodexConnectionOptions } from './codex/adapter.ts'

/** Provider route this plugin owns. */
export const PROVIDER = 'codex'
/** User-settings namespace. */
export const NS = settingsNamespace('openai-codex')

export const name = 'openai-codex'
// `connection` is injected lazily (like credentials) so the LLM adapter still
// activates in deployments without the client-connection service; the settings
// RPC channel registers when (and only when) the service starts. ctx.inject
// waits for the service — a synchronous ctx.get() would lose the race when
// this plugin loads before client-connection and never mount the channel.
export const inject = ['llm']

/**
 * RPC channel (browser ↔ Host) for the settings card.
 *
 * The Connection RPC transport requires a single-segment channel
 * (`/^\/[A-Za-z0-9._~-]+$/`); a nested path such as `/rpc/codex` is rejected
 * as an invalid RPC target on both the client and the Host, so the plugin uses
 * the flat `/rpc-codex` channel.
 */
export const RPC_CHANNEL = '/rpc-codex'

/** Default refresh lead time: refresh an access token 5 min before expiry. */
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000
/** Idle watchdog default. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Plugin configuration, mirroring llm-deepseek's shape. */
export interface Config {
  /** Codex responses endpoint. */
  baseURL?: string
  /** Advisory model catalog. */
  models?: CodexCatalogModel[]
  /** Default context capacity when a model lacks one. */
  defaultContextWindow?: number
  /** Default output cap. */
  maxTokens?: number
  /** Text verbosity hint. */
  verbosity?: 'low' | 'medium' | 'high'
  /** Default reasoning effort. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max'
  /** Refresh lead time before expiry. */
  refreshBeforeMs?: number
  /** Idle watchdog while reading a stream. */
  streamIdleTimeoutMs?: number
  /** Provider-owned retry policy. */
  retryPolicy?: RetryPolicyConfig
  /** Strip redundant model-emitted `sandbox_permissions` from tool calls (default true). */
  sanitizeSandboxPermissions?: boolean
}

const catalogModel: z<CodexCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  baseURL: z.string().default(OPENAI_CODEX_API_ENDPOINT),
  models: z.array(catalogModel).default([...DEFAULT_CODEX_MODELS]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CODEX_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_CODEX_MAX_TOKENS),
  verbosity: z.union(['low', 'medium', 'high']),
  reasoningEffort: z.union(['off', 'low', 'medium', 'high', 'max']),
  refreshBeforeMs: z.number().step(1).min(0).default(DEFAULT_REFRESH_BEFORE_MS),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  sanitizeSandboxPermissions: z.boolean().default(true),
})

/** Validate, detach, and de-duplicate the model catalog. */
function resolveModels(models: readonly CodexCatalogModel[] | undefined): CodexCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_CODEX_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('openai-codex: catalog model ids must be non-empty')
    if (seen.has(model.id)) throw new Error(`openai-codex: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

const connectionFromConfig = (config: Config): CodexConnectionOptions => ({
  baseURL: config.baseURL ?? OPENAI_CODEX_API_ENDPOINT,
  maxTokens: config.maxTokens ?? DEFAULT_CODEX_MAX_TOKENS,
  defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CODEX_CONTEXT_WINDOW,
  models: resolveModels(config.models),
  verbosity: config.verbosity,
  reasoningEffort: config.reasoningEffort,
  refreshBeforeMs: config.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS,
  streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(config.retryPolicy, 'openai-codex: retryPolicy'),
  sanitizeSandboxPermissions: config.sanitizeSandboxPermissions ?? true,
})

/**
 * Best-effort open of a browser URL using the platform opener. The authorize
 * URL is always surfaced to the card regardless, so a failed open is not fatal.
 */
function openBrowser(url: string): void {
  try {
    const { execSync } = requireNode('node:child_process') as { execSync: (cmd: string, options: { stdio: 'ignore'; timeout: number }) => unknown }
    const platform = process.platform
    const cmd = platform === 'darwin'
      ? `open '${url}'`
      : platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open '${url}'`
    execSync(cmd, { stdio: 'ignore', timeout: 3000 })
  } catch {
    // Non-fatal: the card shows the URL.
  }
}

/** Lazy require a Node builtin (Host-only). */
function requireNode(id: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(id)
}

/** One RPC endpoint's handler result (existing RpcResult shape). */
type RpcOk<T> = { ok: true; value: T }
type RpcFail = { ok: false; error: RpcError }

/** Build an RPC failure result. */
function rpcFail(message: string, code: RpcError['code'] = 'internal'): RpcFail {
  return { ok: false, error: { code, message, details: { issues: [] } } as RpcError }
}

/** Single-flight token refresh guard shared by the adapter and status reads. */
function singleFlightRefresher(ctx: Context) {
  let inflight: Promise<OAuthCredential> | undefined
  return async (refreshToken: string): Promise<OAuthCredential> => {
    inflight ??= refreshOpenAICodexToken(refreshToken, new AbortController().signal)
      .then(credential => writeStoredCredential(ctx, credential).then(() => credential))
      .finally(() => { inflight = undefined })
    return inflight
  }
}

const ok = <T>(value: T): RpcOk<T> => ({ ok: true, value })

/**
 * Host plugin body. All registrations are fiber effects, so reloads tear them
 * down cleanly and re-entry is safe.
 */
export function apply(ctx: Context, config: Config): void {
  // ---- Resolvable connection facts (settings-aware) ----
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: CodexConnectionOptions | undefined
  const options = (): CodexConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = connectionFromConfig(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      ctx.logger.error('openai-codex: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  // ---- Settings namespace (config surface) ----
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (next) => { current = next },
    onChange: () => { options() },
  })

  // ---- Credential / auth helpers ----
  const refreshOnce = singleFlightRefresher(ctx)

  const resolveCredential = async (): Promise<OAuthCredential> => {
    const credential = await readStoredCredential(ctx)
    if (credential === null) {
      throw new LlmError(
        'OpenAI Codex is not authenticated; open Settings → OpenAI Codex and authenticate with your ChatGPT subscription',
        'MISSING_CREDENTIAL',
      )
    }
    return credential
  }

  const adapter = new CodexAdapter({
    options,
    resolveCredential: () => resolveCredential(),
    refreshAccessToken: (refreshToken) => refreshOnce(refreshToken),
    clearCredential: () => clearStoredCredential(ctx),
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'OpenAI Codex', settingsNs: String(NS), settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // ---- Browser ↔ Host RPC channel for the settings card ----
  // ctx.inject waits for the optional `connection` service: a synchronous
  // ctx.get() loses the race when this plugin loads before client-connection,
  // the channel never mounts, and the browser's POST falls through to the SPA
  // static fallback (HTTP 405).
  ctx.inject(['connection'], (connCtx) => {
    const connection = connCtx.get('connection') as { rpc: { handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'loopback' },
    ) => () => Promise<void> } }
    const dispose = connection.rpc.handle(RPC_CHANNEL, async (endpoint, _payload, signal) => {
      try {
        switch (endpoint) {
          case 'status': {
            const status: CodexAuthStatus = await readAuthStatus(ctx)
            return ok(status)
          }
          case 'login.browser': {
            const credential = await browserOAuthLogin(openBrowser, signal)
            await writeStoredCredential(ctx, credential)
            return ok(await readAuthStatus(ctx))
          }
          case 'login.device.begin': {
            const flowSession: DeviceFlowSession = await beginDeviceFlow(signal)
            return ok(flowSession)
          }
          case 'login.device.poll': {
            const session = _payload as Partial<DeviceFlowSession> | undefined
            if (session === undefined || typeof session.deviceAuthId !== 'string' || typeof session.userCode !== 'string') {
              return rpcFail('missing device session', 'bad-request')
            }
            const result = await pollDeviceFlowOnce(
              {
                deviceAuthId: session.deviceAuthId,
                userCode: session.userCode,
                verificationUri: session.verificationUri ?? DEVICE_VERIFICATION_FALLBACK,
                intervalSeconds: session.intervalSeconds ?? 5,
                expiresInSeconds: session.expiresInSeconds ?? 900,
              },
              signal,
            )
            if (result.status === 'complete') {
              await writeStoredCredential(ctx, result.credential)
              return ok({ status: 'complete' as const })
            }
            if (result.status === 'failed') return ok({ status: 'failed' as const, message: result.message })
            return ok({ status: 'pending' as const })
          }
          case 'logout': {
            await clearStoredCredential(ctx)
            return ok(await readAuthStatus(ctx))
          }
          default:
            return rpcFail(`unknown endpoint "${endpoint}"`, 'bad-request')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return rpcFail(message, 'internal')
      }
    }, { authority: 'loopback' })
    connCtx.effect(() => () => { void dispose() }, `${RPC_CHANNEL} rpc channel`)
  })
}

// Type-only re-exports for downstream consumers of the package root.
export type { CodexAuthStatus, OAuthCredential } from './oauth/types.ts'
export type { CodexConnectionOptions, CodexAdapterOptions } from './codex/adapter.ts'
export type { CodexCatalogModel } from './oauth/models.ts'
// Reference the redirect URI so callers can show it in custom copy.
export { OPENAI_BROWSER_REDIRECT_URI as BROWSER_REDIRECT_URI_FOR_CARD } from './oauth/constants.ts'
