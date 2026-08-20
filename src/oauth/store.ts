/**
 * OAuth credential persistence through the DSH credentials seam. The whole
 * token envelope (access + refresh + expiry + account id) is stored as a JSON
 * string under one credential reference (`OPENAI_CODEX_CREDENTIAL`). This
 * keeps tokens out of settings/config files and under the same owner-only,
 * file-backed management as API keys.
 *
 * @module dsh-openai-codex/oauth/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CodexAuthStatus, OAuthCredential } from './types.ts'

/** Credential reference holding the full codex token envelope. */
export const CODEX_CREDENTIAL_REF = credentialRef('OPENAI_CODEX_CREDENTIAL')

/** Access the credentials service, or fail loudly with a clear message. */
function credentials(ctx: Context): CredentialProvider {
  const service = ctx.get('credentials')
  if (service === undefined) {
    throw new LlmError(
      'OpenAI Codex needs the credentials service; it is not composed in this deployment',
      'MISSING_CREDENTIAL',
    )
  }
  return service
}

/** Read and parse the stored credential envelope, or null if absent/malformed. */
export async function readStoredCredential(ctx: Context): Promise<OAuthCredential | null> {
  const hit = await credentials(ctx).resolve(CODEX_CREDENTIAL_REF)
  if (hit === undefined || hit.value.length === 0) return null
  try {
    const parsed = JSON.parse(hit.value) as OAuthCredential
    if (parsed.type !== 'oauth' || typeof parsed.access !== 'string'
      || typeof parsed.refresh !== 'string' || typeof parsed.accountId !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Persist a credential envelope. */
export async function writeStoredCredential(ctx: Context, credential: OAuthCredential): Promise<void> {
  await credentials(ctx).set(CODEX_CREDENTIAL_REF, JSON.stringify(credential))
}

/** Clear any stored credential (sign out / revoked refresh token). */
export async function clearStoredCredential(ctx: Context): Promise<void> {
  const service = ctx.get('credentials')
  if (service !== undefined) await service.unset(CODEX_CREDENTIAL_REF)
}

/** Public (non-secret) auth status for the settings card. */
export async function readAuthStatus(ctx: Context): Promise<CodexAuthStatus> {
  const credential = await readStoredCredential(ctx)
  if (credential === null) return { signedIn: false }
  return { signedIn: true, accountId: credential.accountId }
}
