/**
 * OpenAI Codex Responses wire types (SSE over the `/codex/responses` endpoint).
 * Types only — see `serialize.ts` (request) and `translate.ts` (response).
 *
 * @module dsh-openai-codex/codex/types
 */

/** Reasoning effort sent on the wire (codex's effort vocabulary). */
export type WireReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'max'

/** A completed tool call replayed on an assistant input item. */
export interface WireFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  /** Raw JSON argument string. */
  arguments: string
}

/** A tool result item. */
export interface WireFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** A message input item (system/user/assistant text). */
export interface WireResponseInputItem {
  type: 'message'
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

/** Any `input` array item. */
export type WireInputItem = WireResponseInputItem | WireFunctionCallItem | WireFunctionCallOutputItem

/** Request body for `POST {baseURL}` (the codex Responses API). */
export interface WireRequestBody {
  model: string
  store: false
  stream: true
  /** System prompt rendered into the top-level `instructions` slot. */
  instructions?: string
  input: WireInputItem[]
  text?: { verbosity?: 'low' | 'medium' | 'high' }
  include?: ['reasoning.encrypted_content']
  tools?: WireTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  temperature?: number
  parallel_tool_calls?: boolean
  reasoning?: { effort?: WireReasoningEffort; summary?: 'auto' | 'concise' | 'detailed' | 'off' | 'on' }
  max_output_tokens?: number
  service_tier?: 'flex' | 'priority' | 'default'
}

/** Tool schema item. */
export interface WireTool {
  type: 'function'
  name: string
  description: string
  /** JSON-schema arguments. */
  parameters?: Record<string, unknown>
}

/** One parsed SSE `data:` payload. OpenAI Responses stream events are discriminated on `type`. */
export type WireStreamEvent = {
  type: string
  [key: string]: unknown
}

/** Usage reported in the terminal response. */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  /** Folded cache-token detail when the provider reports it. */
  input_tokens_details?: { cached_tokens?: number; text_tokens?: number }
  output_tokens_details?: { text_tokens?: number; reasoning_tokens?: number }
}

/** Non-2xx error body (codex uses `{ error: { message } }` or plain). */
export interface WireError {
  error?: { message?: string; code?: string; type?: string }
}
