/**
 * Typed wrapper over the generic Connection RPC channel the Host half serves
 * (`/rpc-codex`). The browser card calls these to run authentication and
 * report status.
 *
 * @module dsh-openai-codex/client/rpc
 */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { CodexAuthStatus, DeviceFlowSession } from '../oauth/types.ts'

/**
 * The channel name served by the Host half.
 *
 * Must be a single path segment: the Connection RPC transport validates the
 * channel against `/^\/[A-Za-z0-9._~-]+$/`, so a nested `/rpc/codex` would be
 * rejected as an invalid RPC target.
 */
export const RPC_CHANNEL = '/rpc-codex'

/** One card-facing result of polling a device-code session. */
export type DevicePollResult =
  | { status: 'complete' }
  | { status: 'pending' }
  | { status: 'failed'; message?: string }

/** Re-export the channel for the card. */
export function rpcChannel(): string {
  return RPC_CHANNEL
}

/** Call an endpoint and surface failures as readable Errors. */
async function call<T>(
  rpc: ClientConnectionRpc,
  endpoint: string,
  payload?: unknown,
): Promise<T> {
  // `payload` must be present in the envelope: the Host's clientRequestSchema
  // treats it as non-optional, and JSON.stringify drops `undefined` — sending
  // no payload gets the whole request rejected as an invalid client-request.
  const result: RpcResult<unknown> = await rpc.call(RPC_CHANNEL, endpoint, payload ?? null)
  if (!result.ok) {
    throw new Error(describeError(result.error))
  }
  return result.value as T
}

/** Render an RPC error into a readable message. */
function describeError(error: { code?: string; message?: string }): string {
  const message = error.message ?? 'OpenAI Codex request failed'
  if (error.code !== undefined && error.code !== 'internal') return `${error.code}: ${message}`
  return message
}

/** The browser-facing RPC handle the card drives. */
export interface CodexRpc {
  /** Current signed-in status. */
  status(): Promise<CodexAuthStatus>
  /** Run the interactive browser OAuth flow (Host opens/manages it). */
  loginBrowser(): Promise<CodexAuthStatus>
  /** Begin a device-code flow, returning the user-facing session. */
  beginDevice(): Promise<DeviceFlowSession>
  /** Poll the active device-code session. */
  pollDevice(session: DeviceFlowSession): Promise<DevicePollResult>
  /** Sign out (clear stored tokens). */
  logout(): Promise<CodexAuthStatus>
}

/** Wrap a {@link ClientConnectionRpc} carrier with the codex endpoints. */
export function bindCodexRpc(rpc: ClientConnectionRpc): CodexRpc {
  return {
    status: () => call<CodexAuthStatus>(rpc, 'status'),
    loginBrowser: () => call<CodexAuthStatus>(rpc, 'login.browser'),
    beginDevice: () => call<DeviceFlowSession>(rpc, 'login.device.begin'),
    pollDevice: (session) => call<DevicePollResult>(rpc, 'login.device.poll', session),
    logout: () => call<CodexAuthStatus>(rpc, 'logout'),
  }
}
