import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CodexAdapter, type CodexAdapterOptions, type CodexConnectionOptions } from '../src/codex/adapter.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { CodexCatalogModel } from '../src/oauth/models.ts'
import type { OAuthCredential } from '../src/oauth/types.ts'

const models: CodexCatalogModel[] = [
  { id: 'gpt-5.5', contextWindow: 400000, maxTokens: 128000 },
]

function connection(overrides: Partial<CodexConnectionOptions> = {}): CodexConnectionOptions {
  return {
    baseURL: 'https://chatgpt.com/backend-api/codex/responses',
    maxTokens: 128000,
    defaultContextWindow: 400000,
    models,
    verbosity: 'low',
    reasoningEffort: undefined,
    refreshBeforeMs: 300_000,
    streamIdleTimeoutMs: 30_000,
    retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], backoff: { type: 'fixed', fixed: 1_000 } } as unknown as CodexConnectionOptions['retryPolicy'],
    sanitizeSandboxPermissions: false,
    ...overrides,
  }
}

const credential: OAuthCredential = {
  type: 'oauth',
  access: 'access_token',
  refresh: 'refresh_token',
  expires: Date.now() + 3_600_000,
  accountId: 'user_1',
}

function adapterOptions(overrides: {
  connection?: CodexConnectionOptions
  resolveCredential?: CodexAdapterOptions['resolveCredential']
  refreshAccessToken?: CodexAdapterOptions['refreshAccessToken']
  clearCredential?: CodexAdapterOptions['clearCredential']
} = {}): CodexAdapterOptions {
  const conn = overrides.connection ?? connection()
  return {
    options: () => conn,
    resolveCredential: overrides.resolveCredential ?? (async () => credential),
    refreshAccessToken: overrides.refreshAccessToken ?? (async (_refresh) => ({ ...credential, type: 'oauth' })),
    clearCredential: overrides.clearCredential ?? (async () => {}),
  }
}

/** A minimal SSE response body with one text message (proper `data:` framing). */
function sseResponse(text: string): Response {
  const lines = [
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
    JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: text }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text }] } }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } }),
  ]
  const payload = `${lines.map(line => `data: ${line}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(new Blob([payload]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('CodexAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', undefined)
  })

  it('providerInfo and listModels advertise the provider and catalog', () => {
    const adapter = new CodexAdapter(adapterOptions())
    expect(adapter.providerInfo('codex')).toEqual({ id: 'codex', name: 'OpenAI Codex' })
    return expect(adapter.listModels('codex')).resolves.toEqual([
      expect.objectContaining({ provider: 'codex', id: 'gpt-5.5' }),
    ])
  })

  it('resolveModel uses catalog window/max-tokens and the configured default effort', () => {
    const adapter = new CodexAdapter(adapterOptions({ connection: connection({ reasoningEffort: 'medium' }) }))
    return expect(adapter.resolveModel('codex', 'gpt-5.5')).resolves.toMatchObject({
      provider: 'codex',
      id: 'gpt-5.5',
      context: { contextWindow: 400000 },
      defaultMaxTokens: 128000,
      reasoning: { defaultEffort: 'medium' },
    })
  })

  it('resolveModel falls back to defaults for an unknown model', () => {
    const adapter = new CodexAdapter(adapterOptions())
    return expect(adapter.resolveModel('codex', 'unknown-model')).resolves.toMatchObject({
      id: 'unknown-model',
      context: { contextWindow: 400000 },
      defaultMaxTokens: 128000,
    })
  })

  it('streams a response into text blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('hi')))
    const adapter = new CodexAdapter(adapterOptions())
    const chunks: string[] = []
    for await (const chunk of adapter.stream({
      provider: 'codex',
      model: 'gpt-5.5',
      messages: [{ id: MessageId('m1'), role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
    })) {
      chunks.push(chunk.type)
    }
    expect(chunks).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('refreshes a near-expiry access token before the request and sends chatgpt-account-id', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: (init.headers as Record<string, string>) })
      return sseResponse('ok')
    }))
    let refreshRan = false
    const adapter = new CodexAdapter(adapterOptions({
      connection: connection(),
      resolveCredential: async () => ({ ...credential, expires: Date.now() - 1 }), // already expired
      refreshAccessToken: async (refresh) => {
        refreshRan = true
        expect(refresh).toBe('refresh_token')
        return { ...credential, expires: Date.now() + 3_600_000 }
      },
    }))
    const chunks: string[] = []
    for await (const chunk of adapter.stream({ provider: 'codex', model: 'gpt-5.5', messages: [] })) {
      chunks.push(chunk.type)
    }
    expect(refreshRan).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/codex/responses')
    expect(calls[0]!.headers['chatgpt-account-id']).toBe('user_1')
    expect(calls[0]!.headers.authorization).toBe('Bearer access_token')
  })

  it('clears the credential and throws AUTH on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 })
    }))
    let cleared = false
    const adapter = new CodexAdapter(adapterOptions({ clearCredential: async () => { cleared = true } }))
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'codex', model: 'gpt-5.5', messages: [] })) { /* consume */ }
    }).rejects.toMatchObject({ code: 'AUTH' })
    expect(cleared).toBe(true)
  })

  it('clears the credential and rethrows when a refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('ok')))
    let cleared = false
    const adapter = new CodexAdapter(adapterOptions({
      resolveCredential: async () => ({ ...credential, expires: Date.now() - 1 }),
      refreshAccessToken: async () => { throw new Error('refresh expired') },
      clearCredential: async () => { cleared = true },
    }))
    await expect(async () => {
      for await (const _ of adapter.stream({ provider: 'codex', model: 'gpt-5.5', messages: [] })) { /* consume */ }
    }).rejects.toThrow('refresh expired')
    expect(cleared).toBe(true)
  })
})
