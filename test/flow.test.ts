import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  beginDeviceFlow,
  pollDeviceFlow,
  pollDeviceFlowOnce,
  refreshOpenAICodexToken,
  exchangeAuthorizationCode,
} from '../src/oauth/flow.ts'
import type { DeviceFlowSession } from '../src/oauth/types.ts'

const session: DeviceFlowSession = {
  deviceAuthId: 'dev_1',
  userCode: 'CODE-1',
  verificationUri: 'https://auth.openai.com/codex/device',
  expiresInSeconds: 900,
  intervalSeconds: 5,
}

/** A fake access JWT carrying the nested ChatGPT account-id claim. */
function accessJwt(accountId = 'user_dev'): string {
  return `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.sig`
}

beforeEach(() => {
  vi.stubGlobal('fetch', undefined)
})

describe('oauth device flow', () => {
  it('beginDeviceFlow parses the device-code response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({ device_auth_id: 'dev_1', user_code: 'CODE-1', interval: 5 }), { status: 200 })
    }))
    const s = await beginDeviceFlow(new AbortController().signal)
    expect(s).toEqual(session)
  })

  it('beginDeviceFlow surfaces a helpful error when device code is disabled (404)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(beginDeviceFlow(new AbortController().signal)).rejects.toThrow(/not enabled/i)
  })

  it('pollDeviceFlowOnce completes by exchanging the returned authorization code', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init?.body ?? '')
      // The device-token poll posts JSON; the code exchange posts a form.
      if (body.startsWith('grant_type=')) {
        const form = new URLSearchParams(body)
        expect(form.get('grant_type')).toBe('authorization_code')
        expect(form.get('code')).toBe('authc')
        return new Response(JSON.stringify({
          access_token: accessJwt(),
          refresh_token: 'ref',
          expires_in: 3600,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ authorization_code: 'authc', code_verifier: 'verifier' }), { status: 200 })
    }))
    const result = await pollDeviceFlowOnce(session, new AbortController().signal)
    expect(result.status).toBe('complete')
    if (result.status === 'complete') {
      expect(result.credential.accountId).toBe('user_dev')
    }
  })

  it('pollDeviceFlowOnce treats pending and slow_down as pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), { status: 400 })))
    expect((await pollDeviceFlowOnce(session, new AbortController().signal)).status).toBe('pending')
  })

  it('pollDeviceFlow loops until the poll signals completion', async () => {
    const fastSession = { ...session, expiresInSeconds: 10, intervalSeconds: 1 }
    type Result =
      | { status: 'pending' }
      | { status: 'complete'; credential: { type: 'oauth'; access: string; refresh: string; expires: number; accountId: string } }
      | { status: 'failed'; message: string }
    const results: Result[] = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'complete', credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'x' } },
    ]
    let i = 0
    const poll: (session: DeviceFlowSession, signal: AbortSignal) => Promise<Result> = async () => results[i++] ?? { status: 'failed', message: 'unexpected' }
    const cred = await pollDeviceFlow(fastSession, poll, new AbortController().signal)
    expect(i).toBe(3)
    expect(cred.access).toBe('a')
  })

  it('pollDeviceFlow respects an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const poll: (session: DeviceFlowSession, signal: AbortSignal) => Promise<{ status: 'pending' }> =
      async () => ({ status: 'pending' })
    await expect(pollDeviceFlow(session, poll, controller.signal)).rejects.toThrow(/cancelled/)
  })
})

describe('oauth token refresh / exchange', () => {
  it('refreshOpenAICodexToken builds the refresh grant and maps tokens', async () => {
    const access = accessJwt('user_x')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body2 = new URLSearchParams(String(init?.body))
      expect(body2.get('grant_type')).toBe('refresh_token')
      expect(body2.get('refresh_token')).toBe('ref')
      return new Response(JSON.stringify({
        access_token: access,
        refresh_token: 'new_ref',
        expires_in: 3600,
      }), { status: 200 })
    }))
    const cred = await refreshOpenAICodexToken('ref', new AbortController().signal)
    expect(cred.access).toBe(access)
    expect(cred.refresh).toBe('new_ref')
    expect(cred.accountId).toBe('user_x')
    expect(cred.expires).toBeGreaterThan(Date.now())
  })

  it('exchangeAuthorizationCode throws LlmError-like on a 400 with error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    await expect(exchangeAuthorizationCode('c', 'v', 'http://localhost', new AbortController().signal))
      .rejects.toThrow()
  })
})
