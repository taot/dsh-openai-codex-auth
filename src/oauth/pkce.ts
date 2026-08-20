/**
 * PKCE (RFC 7636) helpers for the OpenAI Codex OAuth flow.
 *
 * Uses the Web Crypto API so it works in Node 20+ and modern browsers. The
 * OAuth flow itself always runs Host-side (Node); the browser half never calls
 * these — it only instructs the Host to begin/complete a flow.
 *
 * @module dsh-openai-codex/oauth/pkce
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Generate a PKCE code_verifier and its S256 code_challenge.
 * @returns the verifier (held by the client) and the challenge (sent in the authorize URL).
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64UrlEncode(verifierBytes)
  const data = new TextEncoder().encode(verifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return { verifier, challenge: base64UrlEncode(new Uint8Array(hashBuffer)) }
}

/**
 * Generate an opaque OAuth `state` value (CSRF protection). Uses Web Crypto,
 * so it is portable across Node 20+ and browsers; the browser half never
 * invokes it directly.
 * @returns a hex state string.
 */
export function createOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
