/**
 * The OpenAI Codex settings card. Renders auth status and buttons to run the
 * interactive (browser) or device-code OAuth flows, and a sign-out action.
 *
 * @module dsh-openai-codex/client/card
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { CodexCardFace } from './controller.ts'
import type { DevicePollResult } from './rpc.ts'
import type { DeviceFlowSession } from '../oauth/types.ts'
import type { NS } from './locales.ts'
import type {} from './locales.ts'

/** Props the settings-plugin card slot binds. */
export type CodexCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NS>
  & InjectFace<CodexCardFace>

/** Poll interval (ms) while a device-code session is pending. */
const DEVICE_POLL_INTERVAL_MS = 3000

/**
 * Render the OpenAI Codex authentication card.
 */
export function CodexCard(props: CodexCardProps) {
  const { t } = props
  const [signedIn, setSignedIn] = useState(false)
  const [accountId, setAccountId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [device, setDevice] = useState<Awaited<ReturnType<CodexCardFace['beginDevice']>> | null>(null)
  const [deviceState, setDeviceState] = useState<'pending' | 'complete' | 'failed'>('pending')

  // Load the initial status on mount.
  useEffect(() => {
    let cancelled = false
    void props.status().then((status) => {
      if (cancelled) return
      setSignedIn(status.signedIn)
      if (status.accountId !== undefined) setAccountId(status.accountId)
    }).catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [props])

  const runBrowserLogin = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const status = await props.loginBrowser()
      setSignedIn(status.signedIn)
      if (status.accountId !== undefined) setAccountId(status.accountId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [props])

  const beginDeviceLogin = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const session = await props.beginDevice()
      setDevice(session)
      setDeviceState('pending')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [props])

  // Poll the active device-code session until it resolves or fails.
  useEffect(() => {
    if (device === null) return
    const activeSession: DeviceFlowSession = device
    let cancelled = false
    let timeout: number | undefined
    function schedule(): void {
      timeout = window.setTimeout(() => { void tick() }, DEVICE_POLL_INTERVAL_MS)
    }
    async function tick(): Promise<void> {
      if (cancelled) return
      let result: DevicePollResult
      try {
        result = await props.pollDevice(activeSession)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setDevice(null)
        }
        return
      }
      if (cancelled) return
      if (result.status === 'complete') {
        setDeviceState('complete')
        setDevice(null)
        void props.status().then((status) => {
          setSignedIn(status.signedIn)
          if (status.accountId !== undefined) setAccountId(status.accountId)
        }).catch(() => {})
      } else if (result.status === 'failed') {
        setDeviceState('failed')
        setDevice(null)
        if (result.message !== undefined) setError(result.message)
      } else {
        schedule()
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [device, props])

  const signOut = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const status = await props.logout()
      setSignedIn(status.signedIn)
      setAccountId(status.accountId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [props])

  return (
    <div data-plugin-card="openai-codex" style={{ display: 'grid', gap: '12px' }}>
      <div data-codex-auth-status>
        <strong>{signedIn ? t('signedIn') : t('signedOut')}</strong>
        {signedIn && accountId !== undefined && <span> — {accountId}</span>}
      </div>

      {error !== undefined && (
        <div data-codex-auth-error style={{ color: 'var(--dsw-alias-state-error-primary, #ef4444)' }}>
          {error}
        </div>
      )}

      {device !== null && (
        <div data-codex-device style={{ display: 'grid', gap: '8px' }}>
          <div>{t('deviceIntro')}</div>
          <div>
            <code>{device.userCode}</code> — <a href={device.verificationUri} target="_blank" rel="noreferrer">{t('verifyUrl')}</a>
          </div>
          <div>{deviceState === 'pending' ? t('devicePending') : t('deviceDone')}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {!signedIn && (
          <>
            <button type="button" disabled={busy} onClick={() => void runBrowserLogin()}>
              {busy ? t('busy') : t('authenticateBrowser')}
            </button>
            <button type="button" disabled={busy} onClick={() => void beginDeviceLogin()}>
              {busy ? t('busy') : t('authenticateDevice')}
            </button>
          </>
        )}
        {signedIn && (
          <button type="button" disabled={busy} onClick={() => void signOut()}>
            {busy ? t('busy') : t('signOut')}
          </button>
        )}
      </div>
    </div>
  )
}
