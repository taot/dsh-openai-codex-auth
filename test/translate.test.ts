import { describe, expect, it } from 'vitest'
import { translate } from '../src/codex/translate.ts'

/// Arrange an async generator of SSE data payloads.
async function* stream(datas: string[]): AsyncGenerator<string> {
  for (const data of datas) yield data
}

/** Helper to collect all chunks from a translate run. */
async function collect(datas: string[]): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of translate(stream(datas))) chunks.push(chunk)
  return chunks
}

describe('translate (codex Responses → StreamChunks)', () => {
  it('maps text deltas into a text block and emits usage before finish', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: ' world' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] } }),
      JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
      '[DONE]',
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks[2]).toEqual({ type: 'text-delta', index: 0, text: ' world' })
    expect(chunks[3]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } })
    // usage before finish
    expect(chunks[4]).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
    expect(chunks[5]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toHaveLength(6)
  })

  it('accumulates tool-call argument fragments into a raw JSON tool-call block', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash' } }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"com' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: 'mand":"ls"}' }),
      JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"command":"ls"}' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
      '[DONE]',
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{"com' })
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', index: 0, argumentsDelta: 'mand":"ls"}' })
    const last = chunks[3]
    expect(last).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(chunks[4]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps reasoning deltas into a reasoning block', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r_1' } }),
      JSON.stringify({ type: 'response.reasoning_text.delta', output_index: 0, delta: 'thinking…' }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'r_1' } }),
      JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
      '[DONE]',
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'thinking…' })
    expect(chunks[2]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } })
    expect(chunks[3]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('throws STREAM_CLOSED when the stream ends without a terminal event', async () => {
    await expect(collect([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }),
      '[DONE]',
    ])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('emits an error finish on response.failed', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.failed', response: { error: { code: 'quota_exceeded', message: 'Monthly usage limit reached' } } }),
      '[DONE]',
    ])
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure.code).toBe('QUOTA_EXCEEDED')
  })

  it('throws on an inline stream error event with a normalized code', async () => {
    await expect(collect([
      JSON.stringify({ type: 'error', code: 'monthly_usage_limit_exceeded', message: 'You are on a plan' }),
      '[DONE]',
    ])).rejects.toMatchObject({ code: 'MONTHLY_USAGE_LIMIT_EXCEEDED' })
  })

  it('handles a stream with no text deltas but a completed response', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }),
      '[DONE]',
    ])
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translate sandbox_permissions sanitization', () => {
  const toolCallEvents = (args: string) => [
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash' } }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: args }),
    JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, arguments: args }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: args } }),
    JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }),
    '[DONE]',
  ]
  const escArgs = JSON.stringify({ command: 'ls', sandbox_permissions: 'workspace-write', justification: 'need access' })

  it('strips a workspace-write restatement even when denial evidence exists', async () => {
    const chunks: unknown[] = []
    for await (const chunk of translate(stream(toolCallEvents(escArgs)), { sandboxPermissionsPolicy: 'strip-redundant', activeSandboxModes: ['workspace-write'] })) chunks.push(chunk)
    const blockEnd = chunks.find(c => (c as { type?: string }).type === 'block-end') as { block: { arguments: string } }
    expect(JSON.parse(blockEnd.block.arguments)).toEqual({ command: 'ls' })
  })

  it('preserves values that do not restate an active mode', async () => {
    const args = JSON.stringify({ command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'really need it' })
    const chunks: unknown[] = []
    for await (const chunk of translate(stream(toolCallEvents(args)), { sandboxPermissionsPolicy: 'strip-redundant', activeSandboxModes: ['workspace-write'] })) chunks.push(chunk)
    const blockEnd = chunks.find(c => (c as { type?: string }).type === 'block-end') as { block: { arguments: string } }
    expect(JSON.parse(blockEnd.block.arguments)).toEqual({ command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'really need it' })
  })


  it('defaults to preserve', async () => {
    const chunks = await collect(toolCallEvents(escArgs))
    const blockEnd = chunks.find(c => (c as { type?: string }).type === 'block-end') as { block: { arguments: string } }
    expect(JSON.parse(blockEnd.block.arguments)).toEqual({ command: 'ls', sandbox_permissions: 'workspace-write', justification: 'need access' })
  })
})
