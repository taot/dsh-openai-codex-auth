/**
 * Serialize harness `GenerateOptions` into an OpenAI Codex Responses request
 * body (SSE). Message roles map to Responses `input` items; assistant tool
 * calls become `function_call` items and tool results `function_call_output`
 * items, preserving conversation order.
 *
 * @module dsh-openai-codex/codex/serialize
 */

import { contentHasImage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { WireInputItem, WireReasoningEffort, WireRequestBody, WireTool } from './types.ts'

/** Connection defaults resolved per request (mirrors llm-deepseek naming). */
export interface CodexRequestDefaults {
  /** Default reasoning effort applied when the request omits one (`undefined` = provider default). */
  reasoningEffort: string | undefined
  /** Default output cap. */
  maxTokens: number
  /** Text verbosity (`undefined` = provider default). */
  verbosity: 'low' | 'medium' | 'high' | undefined
}

/** Map a harness reasoning-effort id to the wire effort. `off` disables reasoning. */
export function wireReasoningEffort(effort: string): WireReasoningEffort | undefined {
  switch (effort) {
    case 'off': return 'minimal'
    case 'low': return 'low'
    case 'medium': return 'medium'
    case 'high': return 'high'
    case 'max': return 'max'
    default: return undefined
  }
}

/** Join the text blocks of a message (user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before the text-only codex route can erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The OpenAI Codex adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize a single tool-result block into a `function_call_output` item. */
function serializeToolResult(block: Extract<ContentBlock, { type: 'tool-result' }>): WireInputItem {
  const output = flattenText(block.content)
  return { type: 'function_call_output', call_id: block.toolCallId, output }
}

/** Serialize one assistant message (text + tool calls) into input items. */
function serializeAssistant(message: Message): WireInputItem[] {
  assertTextOnly(message.content)
  const text = flattenText(message.content)
  const toolCalls = message.content.filter(block => block.type === 'tool-call')
  const items: WireInputItem[] = []
  if (text.length > 0 || toolCalls.length === 0) {
    // Assistant output must be typed `output_text`; `input_text` is rejected
    // ("Supported values are: 'output_text' and 'refusal'").
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  }
  for (const call of toolCalls) {
    items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
  }
  return items
}

/**
 * Build the full codex Responses request body.
 * @param options - the assembled harness request.
 * @param defaults - connection defaults resolved by the adapter.
 * @returns the `WireRequestBody` to POST.
 */
export function buildRequestBody(options: GenerateOptions, defaults: CodexRequestDefaults): WireRequestBody {
  const input: WireInputItem[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      const text = flattenText(message.content)
      if (text.length > 0) input.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] })
      continue
    }
    if (message.role === 'assistant') {
      input.push(...serializeAssistant(message))
      continue
    }
    // user role: text plus any tool-result blocks (harness puts each tool
    // result in its own user message or alongside user text).
    assertTextOnly(message.content)
    const text = flattenText(message.content)
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || toolResults.length === 0) {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
    }
    for (const result of toolResults) input.push(serializeToolResult(result))
  }

  const tools: WireTool[] | undefined = options.tools === undefined || options.tools.length === 0
    ? undefined
    : options.tools.map(tool => serialiseTool(tool))

  const rawEffort = options.reasoningEffort === undefined ? defaults.reasoningEffort : options.reasoningEffort
  const effort = rawEffort === undefined || rawEffort === ReasoningEffortId('off') ? undefined : wireReasoningEffort(rawEffort)

  const body: WireRequestBody = {
    model: options.model,
    store: false,
    stream: true,
    ...options.system !== undefined && options.system.length > 0 ? { instructions: options.system } : {},
    input,
    // The codex backend expects encrypted reasoning content to round-trip
    // for reasoning models; omitting `include` is rejected on some models.
    include: ['reasoning.encrypted_content'],
    ...tools === undefined ? {} : { tools, tool_choice: 'auto', parallel_tool_calls: true },
    ...effort === undefined ? {} : { reasoning: { effort, summary: 'auto' } },
    ...defaults.verbosity === undefined ? {} : { text: { verbosity: defaults.verbosity } },
    // NOTE: no max_output_tokens — the codex backend rejects it with HTTP 400.
  }
  return body
}

/** Normalize a harness tool schema to the codex wire form. */
function serialiseTool(tool: ToolSchema): WireTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    ...tool.parameters !== undefined ? { parameters: tool.parameters } : {},
  }
}
