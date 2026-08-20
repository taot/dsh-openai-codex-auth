/**
 * OpenAI Codex (ChatGPT Plus/Pro) OAuth endpoints and identities.
 *
 * These constants mirror the working CLI clients (pi and opencode). OpenAI can
 * rotate them; the values below reproduce the current public flow.
 *
 * @module dsh-openai-codex/oauth/constants
 */

/** Public OAuth client id used by codex CLI integrations. */
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** OpenAI identity issuer. */
export const OPENAI_ISSUER = 'https://auth.openai.com'
export const OPENAI_AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`
export const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
export const OPENAI_DEVICE_CODE_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`
export const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`
/** Verification page for device-code login. */
export const OPENAI_DEVICE_VERIFICATION_URI = `${OPENAI_ISSUER}/codex/device`
/** Redirect for the device-code authorization-code exchange. */
export const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`
/** OAuth scope required for offline refresh tokens + account identity. */
export const OPENAI_CODEX_SCOPE = 'openid profile email offline_access'
/** Local redirect used by the interactive browser flow. */
export const OPENAI_BROWSER_REDIRECT_HOST = '127.0.0.1'
export const OPENAI_BROWSER_REDIRECT_PORT = 1455
// The client_id's registered redirect URI is `http://localhost:1455/...`
// (exact match — `127.0.0.1` is rejected with invalid_authorize_request).
// The callback server still binds 127.0.0.1, where localhost resolves.
export const OPENAI_BROWSER_REDIRECT_URI = `http://localhost:${OPENAI_BROWSER_REDIRECT_PORT}/auth/callback`
/** Device-code flow lifetime. */
export const OPENAI_DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
/** Codex request endpoint (Responses API over SSE). */
export const OPENAI_CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
