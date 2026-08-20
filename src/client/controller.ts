/**
 * Card controller: binds the Host RPC to plain card actions. No pushed store —
 * the React card manages its own local UI state and calls these actions.
 *
 * @module dsh-openai-codex/client/controller
 */

import type { CodexRpc, DevicePollResult } from './rpc.ts'
import type { CodexAuthStatus, DeviceFlowSession } from '../oauth/types.ts'

/** The face the settings-plugin card slot injects (plain props; no hooks). */
export interface CodexCardFace {
  /** Current signed-in status. */
  status(): Promise<CodexAuthStatus>
  /** Run the interactive browser OAuth flow. */
  loginBrowser(): Promise<CodexAuthStatus>
  /** Begin a device-code flow. */
  beginDevice(): Promise<DeviceFlowSession>
  /** Poll the active device-code session. */
  pollDevice(session: DeviceFlowSession): Promise<DevicePollResult>
  /** Sign out. */
  logout(): Promise<CodexAuthStatus>
}

/** Build the card face from a bound RPC handle. */
export function createCodexCardFace(rpc: CodexRpc): CodexCardFace {
  return {
    status: () => rpc.status(),
    loginBrowser: () => rpc.loginBrowser(),
    beginDevice: () => rpc.beginDevice(),
    pollDevice: (session) => rpc.pollDevice(session),
    logout: () => rpc.logout(),
  }
}
