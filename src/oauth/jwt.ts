/**
 * JWT helpers for extracting the ChatGPT account id from an OpenAI access
 * token. The account id is carried in the `https://api.openai.com/auth`
 * claim's `chatgpt_account_id` field (an opaque account identifier codex uses
 * on the `chatgpt-account-id` request header).
 *
 * @module dsh-openai-codex/oauth/jwt
 */

/** The claim path OpenAI embeds ChatGPT identity under. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

interface AuthClaim {
  chatgpt_account_id?: unknown
}

interface JwtPayload {
  [JWT_CLAIM_PATH]?: AuthClaim
  chatgpt_account_id?: unknown
  [key: string]: unknown
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const payloadPart = parts[1]
  if (payloadPart === undefined) return null
  try {
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const decoded = atob(padded)
    return JSON.parse(decoded) as JwtPayload
  } catch {
    return null
  }
}

/**
 * Extract the ChatGPT account id from an access token.
 * @param accessToken - the OAuth access token (JWT).
 * @returns the account id, or undefined when it cannot be extracted.
 */
export function getChatGptAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  if (payload === null) return undefined
  const nested = payload[JWT_CLAIM_PATH]?.chatgpt_account_id
  const accountId = typeof nested === 'string' && nested.length > 0
    ? nested
    : (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id.length > 0
        ? payload.chatgpt_account_id
        : undefined)
  return accountId
}
