import { describe, expect, it } from 'vitest'
import { buildRequestBody } from '../src/codex/serialize.ts'
import type { Message, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MessageId, CallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

function textMessage(role: Message['role'], text: string): Message {
  return {
    id: MessageId(`m_${Math.random().toString(36).slice(2)}`),
    role,
    content: [{ type: 'text', text }],
    source: role === 'assistant' ? { kind: 'model', model: 'codex', usage: { inputTokens: 0, outputTokens: 0 } } : { kind: 'user' },
  } as Message
}

function baseOptions(): GenerateOptions {
  return {
    provider: 'codex',
    model: 'gpt-5.5',
    messages: [textMessage('user', 'hi')],
  }
}

const defaults = { reasoningEffort: 'high', maxTokens: 128_000, verbosity: 'low' as const }

describe('serialize (GenerateOptions → codex Responses body)', () => {
  it('builds a minimal streaming body', () => {
    const body = buildRequestBody(baseOptions(), defaults)
    expect(body.model).toBe('gpt-5.5')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
    // The codex backend rejects max_output_tokens, so it must never be sent.
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.include).toEqual(['reasoning.encrypted_content'])
  })

  it('maps the system prompt to instructions and paths reasoning effort', () => {
    const body = buildRequestBody({ ...baseOptions(), system: 'You are helpful.' }, defaults)
    expect(body.instructions).toBe('You are helpful.')
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('serializes tools and assistant tool calls as function_call items', () => {
    const assistant = {
      id: MessageId('m_a'),
      role: 'assistant' as const,
      content: [{ type: 'tool-call', id: CallId('call_x'), name: 'bash', arguments: '{"command":"ls"}' }],
      source: { kind: 'model', model: 'codex', provider: 'codex', usage: { inputTokens: 0, outputTokens: 0 } },
    } as unknown as Message
    const body = buildRequestBody({
      ...baseOptions(),
      messages: [assistant],
      tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' } }],
    }, defaults)
    const calls = body.input.filter(item => item.type === 'function_call')
    expect(calls).toEqual([{ type: 'function_call', call_id: 'call_x', name: 'bash', arguments: '{"command":"ls"}' }])
    expect(body.tools).toEqual([{ type: 'function', name: 'bash', description: 'Run a command', parameters: { type: 'object' } }])
  })

  it('serializes tool results as function_call_output preserving raw JSON arguments', () => {
    const toolResult = {
      id: MessageId('m_t'),
      role: 'user' as const,
      content: [{ type: 'tool-result', toolCallId: CallId('call_x'), content: [{ type: 'text', text: '{"ok":true}' }] }],
      source: { kind: 'tool', callId: CallId('call_x') },
    } as unknown as Message
    const body = buildRequestBody({ ...baseOptions(), messages: [toolResult] }, defaults)
    expect(body.input).toEqual([
      { type: 'function_call_output', call_id: 'call_x', output: '{"ok":true}' },
    ])
  })

  it('omits reasoning when effort is off', () => {
    const body = buildRequestBody(baseOptions(), defaults)
    expect(body.reasoning).toBeDefined()
    const offBody = buildRequestBody({ ...baseOptions(), reasoningEffort: ReasoningEffortId('off') }, defaults)
    expect(offBody.reasoning).toBeUndefined()
  })
})
