/**
 * Translate OpenAI Codex Responses SSE events into harness `StreamChunk`s.
 *
 * Contract obligations (docs/cookbook/adding-an-llm-adapter.md + the
 * `StreamChunk` doc in packages/llm/llm/src/types.ts):
 * - A `block-start` opens each content block; deltas follow; a `block-end`
 *   closes it with the assembled block.
 * - Tool-call `arguments` stay raw JSON strings end-to-end; streamed fragments
 *   ride `tool-call-delta.argumentsDelta`, and `block-end` carries the
 *   concatenated string.
 * - Emit `usage` BEFORE the terminal `finish`, and nothing after `finish`.
 *   We buffit completion until the provider's end-of-stream marker, then flush
 *   usage followed by finish.
 * - Errors surface only by throwing {@link LlmError} (transport/protocol) or
 *   by a `finish { kind: 'error' | 'aborted' }` (provider in-band failure).
 *
 * The Responses stream addresses each output item with a stable `output_index`:
 * we use it directly as the DSH block `index`, which satisfies the "first-seen
 * stream order, stable across deltas" requirement.
 *
 * @module dsh-openai-codex/codex/translate
 */

import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { WireStreamEvent, WireUsage } from './types.ts'

/**
 * Policy for model-emitted sandbox escalation arguments on tool calls.
 *
 * Some models attach a no-op `sandbox_permissions: "workspace-write"` even
 * though the session is already workspace-write; the harness rejects that as
 * an invalid escalation before the tool ever runs. `strip-redundant` removes
 * the key (and its paired `justification`) whenever its value restates an
 * active sandbox mode; any other value is a genuine escalation and is kept.
 */
export type SandboxPermissionsPolicy = 'preserve' | 'strip-redundant'

/** Options for {@link translate}. */
export interface TranslateOptions {
  /** Sandbox argument policy; defaults to `preserve`. */
  sandboxPermissionsPolicy?: SandboxPermissionsPolicy
  /**
   * Active sandbox modes named by denials in the conversation (e.g.
   * `["workspace-write"]`). A `sandbox_permissions` equal to one of these is
   * a redundant restatement — never a valid escalation — and is stripped.
   */
  activeSandboxModes?: readonly string[]
}

/** Rewrite tool-call arguments, dropping redundant sandbox escalation keys. */
function sanitizeToolArguments(argumentsJson: string, policy: SandboxPermissionsPolicy, activeModes: readonly string[]): string {
  if (policy !== 'strip-redundant' || activeModes.length === 0 || !argumentsJson.includes('sandbox_permissions')) return argumentsJson
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return argumentsJson
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return argumentsJson
  const record = parsed as Record<string, unknown>
  const value = record.sandbox_permissions
  if (typeof value !== 'string' || !activeModes.includes(value.toLowerCase())) return argumentsJson
  const next = { ...record }
  delete next.sandbox_permissions
  if (typeof next.justification === 'string') delete next.justification
  return JSON.stringify(next)
}

/** Map codex usage to the disjoint harness accounting (codex may fold cache tokens). */
function mapUsage(raw: WireUsage | undefined): TokenUsage | undefined {
  if (raw === undefined) return undefined
  const input = raw.input_tokens ?? 0
  const cached = raw.input_tokens_details?.cached_tokens ?? 0
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: raw.output_tokens ?? 0,
    ...cached > 0 ? { cacheReadTokens: cached } : {},
    ...raw.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: raw.output_tokens_details.reasoning_tokens }
      : {},
  }
}

type BlockKind = 'text' | 'reasoning' | 'tool-call'

/** In-progress content-block assembly keyed by output index. */
interface PendingBlock {
  kind: BlockKind
  /** Whether `block-start` was already emitted for this block. */
  started: boolean
  text: string | undefined
  reasoning: string | undefined
  id: string | undefined
  name: string | undefined
  arguments: string | undefined
}

/** A fresh, not-yet-started pending block of the given kind. */
function newBlock(kind: BlockKind): PendingBlock {
  return { kind, started: false, text: undefined, reasoning: undefined, id: undefined, name: undefined, arguments: undefined }
}

/** Parse one SSE `data` payload into an event object, or return null if not JSON. */
function parseEvent(data: string): WireStreamEvent | null {
  if (data.length === 0 || data === '[DONE]') return null
  try {
    return JSON.parse(data) as WireStreamEvent
  } catch {
    return null
  }
}

/**
 * Translate a stream of parsed SSE payload strings into harness StreamChunks.
 * @param datas - SSE data payloads (including a trailing `[DONE]`).
 * @returns the harness `StreamChunk` sequence for the response.
 */
export async function* translate(datas: AsyncGenerator<string>, options: TranslateOptions = {}): AsyncGenerator<StreamChunk> {
  const sandboxPolicy = options.sandboxPermissionsPolicy ?? 'preserve'
  const activeModes = options.activeSandboxModes ?? []
  const pending = new Map<number, PendingBlock>()
  let sawTerminal = false
  let terminalUsage: WireUsage | undefined
  let terminalError: { code?: string; message?: string } | undefined

  const ensure = (index: number, kind: BlockKind, init?: Partial<Pick<PendingBlock, 'text' | 'reasoning' | 'id' | 'name' | 'arguments'>>): PendingBlock => {
    let block = pending.get(index)
    if (block === undefined) {
      block = { ...newBlock(kind), ...init }
      pending.set(index, block)
    } else if (block.kind !== kind) {
      // A new block reused an index slot — replace (rare; be defensive).
      block = { ...newBlock(kind), ...init }
      pending.set(index, block)
    }
    return block
  }

  const beginIfNeeded = function* (block: PendingBlock, index: number): Generator<StreamChunk> {
    if (block.started) return
    block.started = true
    yield { type: 'block-start', index, blockType: block.kind }
  }

  for await (const data of datas) {
    const event = parseEvent(data)
    if (event === null) continue
    const type = event.type

    if (type === 'response.output_item.added') {
      const item = event.item as { type?: string; call_id?: string; name?: string } | undefined
      const index = numberIndex(event.output_index, nextIndex(pending))
      if (item?.type === 'function_call') {
        pending.set(index, { ...newBlock('tool-call'), id: item.call_id, name: item.name, arguments: '' })
      } else if (item?.type === 'message') {
        pending.set(index, { ...newBlock('text'), text: '' })
      } else if (item?.type === 'reasoning') {
        pending.set(index, { ...newBlock('reasoning'), reasoning: '' })
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      const index = numberIndex(event.output_index, nextIndex(pending))
      const block = ensure(index, 'text', { text: '' })
      block.kind = 'text'
      block.text = (block.text ?? '') + String(event.delta ?? '')
      yield* beginIfNeeded(block, index)
      yield { type: 'text-delta', index, text: String(event.delta ?? '') }
      continue
    }

    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      const index = numberIndex(event.output_index, nextIndex(pending))
      const block = ensure(index, 'reasoning', { reasoning: '' })
      block.kind = 'reasoning'
      block.reasoning = (block.reasoning ?? '') + String(event.delta ?? '')
      yield* beginIfNeeded(block, index)
      yield { type: 'reasoning-delta', index, text: String(event.delta ?? '') }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const index = numberIndex(event.output_index, nextIndex(pending))
      const block = ensure(index, 'tool-call', { arguments: '' })
      block.kind = 'tool-call'
      block.arguments = (block.arguments ?? '') + String(event.delta ?? '')
      yield* beginIfNeeded(block, index)
      yield {
        type: 'tool-call-delta',
        index,
        id: CallId(block.id ?? `call_${index}`),
        ...block.name !== undefined ? { name: block.name } : {},
        argumentsDelta: String(event.delta ?? ''),
      }
      continue
    }

    if (type === 'response.function_call_arguments.done') {
      const index = numberIndex(event.output_index, nextIndex(pending))
      const block = pending.get(index)
      if (block !== undefined) block.arguments = sanitizeToolArguments(String(event.arguments ?? ''), sandboxPolicy, activeModes)
      continue
    }

    if (type === 'response.output_item.done') {
      const item = event.item as { type?: string; call_id?: string; name?: string; arguments?: string; content?: unknown } | undefined
      const index = numberIndex(event.output_index, pending.size > 0 ? maxIndex(pending) : 0)
      const block = pending.get(index)
      if (block === undefined) continue
      if (item?.type === 'message') {
        const text = extractOutputText(item.content)
        yield* beginIfNeeded(block, index)
        yield { type: 'block-end', index, block: { type: 'text', text } }
      } else if (item?.type === 'function_call') {
        const name = block.name ?? item.name
        const args = sanitizeToolArguments(item.arguments ?? block.arguments ?? '{}', sandboxPolicy, activeModes)
        const id = CallId(block.id ?? item.call_id ?? `call_${index}`)
        block.name = name
        block.arguments = args
        yield* beginIfNeeded(block, index)
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id, name: name ?? '', arguments: args } satisfies ToolCallBlock,
        }
      } else if (item?.type === 'reasoning') {
        const reasoning = block.reasoning ?? ''
        yield* beginIfNeeded(block, index)
        yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
      }
      pending.delete(index)
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.done') {
      sawTerminal = true
      const response = event.response as { usage?: WireUsage; status?: string; error?: { code?: string; message?: string } } | undefined
      terminalUsage = response?.usage
      if (response?.status === 'incomplete' || response?.status === 'failed') {
        terminalError = response?.error
      }
      continue
    }

    if (type === 'error') {
      const code = typeof event.code === 'string' ? event.code : undefined
      const message = typeof event.message === 'string' ? event.message : 'Unknown codex stream error'
      throw new LlmError(message, normaliseErrorCode(code, message))
    }

    if (type === 'response.failed') {
      const response = event.response as { error?: { code?: string; message?: string }; status?: string } | undefined
      sawTerminal = true
      terminalError = response?.error
    }
  }

  if (!sawTerminal) {
    throw new LlmError('OpenAI Codex stream ended before a terminal response', 'STREAM_CLOSED')
  }

  // Terminal: emit any remaining assembled usage, then the finish.
  const usage = mapUsage(terminalUsage)
  if (usage !== undefined) yield { type: 'usage', usage }

  if (terminalError !== undefined) {
    const message = terminalError.message ?? 'OpenAI Codex request failed'
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code: normaliseErrorCode(terminalError.code, message) } } }
    return
  }

  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Extract concatenated text from a Responses output message `content` array. */
function extractOutputText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
    .map(part => (part.type === 'output_text' ? part.text ?? '' : ''))
    .join('')
}

/** Read a numeric `output_index` field, or fall back. */
function numberIndex(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nextIndex(pending: Map<number, PendingBlock>): number {
  return pending.size === 0 ? 0 : maxIndex(pending) + 1
}

function maxIndex(pending: Map<number, PendingBlock>): number {
  let max = -1
  for (const key of pending.keys()) if (key > max) max = key
  return max
}

/** Map provider failure strings to stable harness error codes. */
function normaliseErrorCode(code: string | undefined, message: string): string {
  if (code !== undefined) {
    const normalized = code.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_:]/g, '')
    if (normalized.length > 0) return normalized
  }
  if (/quota|usage limit|insufficient_quota|out of budget|billing/i.test(message)) return 'QUOTA_EXCEEDED'
  return 'PROVIDER_ERROR'
}
