/**
 * Browser half of the OpenAI Codex plugin: registers the auth card into the
 * Settings → Plugin Configuration tab and wires it to the Host RPC channel.
 *
 * @module dsh-openai-codex/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settingsScope / locale / slots context merges and the
// settings-plugin card slot contract. Cross-plugin collaboration goes through
// cordis services, never value imports (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createCodexCardFace } from './controller.ts'
import type { CodexCardFace } from './controller.ts'
import { bindCodexRpc } from './rpc.ts'
import { en, zh, NS, type CodexKey } from './locales.ts'
import { CodexCard } from './card.tsx'

export type { CodexCardFace } from './controller.ts'
export type { CodexCardProps, CodexCard } from './card.tsx'
export type { CodexKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The OpenAI Codex settings card's copy. */
    [NS]: CodexKey
  }
}

/** Required services: the wire handle, slot/registry, and locale registration. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the auth card into the plugin-config tab.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Register the card's locale dictionary.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'openai-codex: settings card dictionaries')

  const connection = ctx.get('connection') as { rpc: ClientConnectionRpc } | undefined
  const face: CodexCardFace = connection === undefined
    ? createUnavailableFace()
    : createCodexCardFace(bindCodexRpc(connection.rpc))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'openai-codex',
    locale: NS,
    inject: () => face,
  }, CodexCard))
}

/**
 * A face that reports "not signed in" and explains the Host RPC is
 * unavailable — used when the connection service is absent.
 */
function createUnavailableFace(): CodexCardFace {
  const fail = (): Promise<never> => Promise.reject(
    new Error('OpenAI Codex Host RPC is unavailable (client-connection not composed)'),
  )
  return {
    status: fail,
    loginBrowser: fail,
    beginDevice: fail,
    pollDevice: () => fail(),
    logout: fail,
  }
}

// Re-export the Context type so type-only consumers can reference it.
export type { Context }
