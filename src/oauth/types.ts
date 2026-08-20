/**
 * OAuth credential and flow types shared across the Host half.
 *
 * @module dsh-openai-codex/oauth/types
 */

/** A single persisted OAuth credential envelope for the ChatGPT subscription. */
export interface OAuthCredential {
  type: 'oauth'
  /** Short-lived access token (JWT) used as the bearer for codex requests. */
  access: string
  /** Long-lived refresh token used to mint fresh access tokens. */
  refresh: string
  /** Epoch ms after which `access` should be considered expired. */
  expires: number
  /** ChatGPT account id extracted from the access token. */
  accountId: string
}

/** A raw token response from the OpenAI token endpoint. */
export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  error?: string
}

/** Status reprieved for a device-code session. */
export type DevicePollStatus = 'pending' | 'complete' | 'failed'

/** The Host-side handle for one in-flight device-code authorization. */
export interface DeviceFlowSession {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

/** Public (non-secret) authentication state surfaced to the settings card. */
export interface CodexAuthStatus {
  signedIn: boolean
  accountId?: string
  /** Human-readable state detail (e.g. an error message). */
  detail?: string
}
