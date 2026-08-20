/**
 * The OpenAI Codex settings card. Renders auth status and buttons to run the
 * interactive (browser) or device-code OAuth flows, and a sign-out action.
 *
 * The card replicates the chrome of the built-in plugin cards (expandable
 * header, chevron, styled footer buttons) with the same `--dsw-alias-*`
 * design tokens, because the client bundle purity gate forbids importing the
 * shared `PluginCard` chrome as a value — an out-of-tree card owns its look.
 *
 * @module dsh-openai-codex/client/card
 */

import { useCallback, useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** Shared style constants mirroring the built-in plugin cards' CSS. */
const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: '12px',
    listStyle: 'none',
    transition: 'border-color .16s, background .16s',
  } as const,
  cardOpen: {
    background: 'var(--dsw-alias-bg-layer-2)',
    borderColor: 'var(--dsw-alias-label-dimmed)',
  } as const,
  header: {
    appearance: 'none',
    width: '100%',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    borderRadius: '12px',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 16px',
    display: 'flex',
    boxSizing: 'border-box',
  } as const,
  headerFocus: {
    outline: '2px solid var(--dsw-alias-brand-primary)',
    outlineOffset: '-2px',
  } as const,
  headText: {
    flexDirection: 'column',
    flex: 1,
    gap: '4px',
    minWidth: 0,
    display: 'flex',
  } as const,
  name: {
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: 1.4,
  } as const,
  description: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '13px',
    lineHeight: 1.5,
  } as const,
  chevron: {
    color: 'var(--dsw-alias-label-tertiary)',
    flex: 'none',
    transition: 'transform .16s',
  } as const,
  body: {
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    margin: '0 16px',
    padding: '4px 0 12px',
  } as const,
  statusRow: {
    alignItems: 'center',
    gap: '8px',
    padding: '8px 0',
    display: 'flex',
    fontSize: '13px',
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-primary)',
  } as const,
  badge: {
    whiteSpace: 'nowrap',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '17px',
  } as const,
  accountId: {
    color: 'var(--dsw-alias-label-tertiary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const,
  error: {
    color: 'var(--dsw-alias-label-error)',
    margin: '8px 0 0',
    fontSize: '12px',
    lineHeight: 1.5,
  } as const,
  footer: {
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 0 4px',
    marginTop: '8px',
    display: 'flex',
  } as const,
  button: {
    appearance: 'none',
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid transparent',
    borderRadius: '8px',
    padding: '5px 14px',
    fontSize: '13px',
    lineHeight: 1.5,
  } as const,
  buttonPrimary: {
    background: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-alias-bg-layer-3)',
  } as const,
  buttonSecondary: {
    borderColor: 'var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'transparent',
  } as const,
  buttonDisabled: {
    opacity: 0.4,
    cursor: 'default',
  } as const,
  device: {
    flexDirection: 'column',
    gap: '8px',
    padding: '12px 0',
    display: 'flex',
  } as const,
  deviceIntro: {
    color: 'var(--dsw-alias-label-secondary)',
    margin: 0,
    fontSize: '13px',
    lineHeight: 1.5,
  } as const,
  deviceCode: {
    alignSelf: 'flex-start',
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '15px',
    fontWeight: 600,
    letterSpacing: '0.08em',
  } as const,
  deviceLink: {
    color: 'var(--dsw-alias-brand-primary)',
    fontSize: '13px',
    lineHeight: 1.5,
  } as const,
  devicePending: {
    color: 'var(--dsw-alias-label-tertiary)',
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
  } as const,
} as const

function mergeStyles(...parts: Array<Record<string, unknown> | undefined>) {
  return Object.assign({}, ...parts.filter(Boolean))
}

/**
 * Render the OpenAI Codex authentication card.
 */
export function CodexCard(props: CodexCardProps) {
  const { t } = props
  const [open, setOpen] = useState(false)
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

  const primaryDisabled = busy
  const actionLabel = busy ? t('busy') : undefined

  return (
    <li data-plugin-card="openai-codex" style={mergeStyles(styles.card, open ? styles.cardOpen : undefined)}>
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={styles.headText}>
          <span style={styles.name}>{t('title')}</span>
          <span style={styles.description}>{t('description')}</span>
        </span>
        <span style={mergeStyles(styles.chevron, open ? { transform: 'rotate(180deg)' } : undefined)}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open && (
        <div data-codex-auth-body style={styles.body}>
          <div data-codex-auth-status style={styles.statusRow}>
            <span style={styles.badge}>{signedIn ? t('signedIn') : t('signedOut')}</span>
            {signedIn && accountId !== undefined && (
              <span style={styles.accountId}>{accountId}</span>
            )}
          </div>

          {error !== undefined && (
            <p data-codex-auth-error role="status" style={styles.error}>{error}</p>
          )}

          {device !== null && (
            <div data-codex-device style={styles.device}>
              <p style={styles.deviceIntro}>{t('deviceIntro')}</p>
              <code style={styles.deviceCode}>{device.userCode}</code>
              <a style={styles.deviceLink} href={device.verificationUri} target="_blank" rel="noreferrer">
                {t('verifyUrl')}
              </a>
              <p style={styles.devicePending}>{deviceState === 'pending' ? t('devicePending') : t('deviceDone')}</p>
            </div>
          )}

          <div style={styles.footer}>
            {!signedIn && (
              <>
                <button
                  type="button"
                  style={mergeStyles(styles.button, styles.buttonSecondary, primaryDisabled ? styles.buttonDisabled : undefined)}
                  disabled={busy}
                  onClick={() => void runBrowserLogin()}
                >
                  {actionLabel ?? t('authenticateBrowser')}
                </button>
                <button
                  type="button"
                  style={mergeStyles(styles.button, styles.buttonPrimary, primaryDisabled ? styles.buttonDisabled : undefined)}
                  disabled={busy}
                  onClick={() => void beginDeviceLogin()}
                >
                  {actionLabel ?? t('authenticateDevice')}
                </button>
              </>
            )}
            {signedIn && (
              <button
                type="button"
                style={mergeStyles(styles.button, styles.buttonSecondary, primaryDisabled ? styles.buttonDisabled : undefined)}
                disabled={busy}
                onClick={() => void signOut()}
              >
                {actionLabel ?? t('signOut')}
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
