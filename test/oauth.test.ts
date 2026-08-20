import { describe, expect, it } from 'vitest'
import { getChatGptAccountId } from '../src/oauth/jwt.ts'
import { generatePKCE, createOAuthState } from '../src/oauth/pkce.ts'
import { parseAuthorizationInput } from '../src/oauth/flow.ts'

/** Base64url-encode JSON into a fake JWT segment (no signature verification in tests). */
function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(claims)}.${enc({})}`
}

describe('oauth jwt', () => {
  it('extracts the ChatGPT account id from the nested claim', () => {
    const token = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'user_abc' } })
    expect(getChatGptAccountId(token)).toBe('user_abc')
  })

  it('extracts the ChatGPT account id from the root claim fallback', () => {
    expect(getChatGptAccountId(fakeJwt({ chatgpt_account_id: 'user_root' }))).toBe('user_root')
  })

  it('returns undefined when the claim is absent', () => {
    expect(getChatGptAccountId(fakeJwt({ sub: 'x' }))).toBeUndefined()
  })

  it('returns undefined for malformed tokens', () => {
    expect(getChatGptAccountId('not-a-jwt')).toBeUndefined()
    expect(getChatGptAccountId('a.b')).toBeUndefined()
  })
})

describe('oauth pkce', () => {
  it('generates a verifier within PKCE allowed length and a matching S256 challenge', async () => {
    const { verifier, challenge } = await generatePKCE()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
      .toString('base64url')
    expect(challenge).toBe(expected)
  })

  it('produces a unique 32-hex-char state string', () => {
    const a = createOAuthState()
    const b = createOAuthState()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('oauth flow parseAuthorizationInput', () => {
  it('parses a full callback URL', () => {
    expect(parseAuthorizationInput('http://127.0.0.1:1455/auth/callback?code=c123&state=s456'))
      .toEqual({ code: 'c123', state: 's456' })
  })

  it('parses code#state paste format', () => {
    expect(parseAuthorizationInput('c123#s456')).toEqual({ code: 'c123', state: 's456' })
  })

  it('parses a bare code', () => {
    expect(parseAuthorizationInput('c123')).toEqual({ code: 'c123' })
  })

  it('returns empty for blank input', () => {
    expect(parseAuthorizationInput('   ')).toEqual({})
  })
})
