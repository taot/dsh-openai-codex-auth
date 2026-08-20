import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/codex/sse.ts'

/** Convert an SSE text into an in-memory ReadableStream. */
function toStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

async function collect(text: string): Promise<string[]> {
  const out: string[] = []
  for await (const data of parseSse(toStream(text) as ReadableStream<BufferSource>)) out.push(data)
  return out
}

describe('parseSse', () => {
  it('yields each data payload and stops at [DONE]', async () => {
    const payload = [
      'data: {"type":"a"}\n\n',
      'data: {"type":"b"}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    expect(await collect(payload)).toEqual(['{"type":"a"}', '{"type":"b"}', '[DONE]'])
  })

  it('joins multi-line data values into one payload (with newline separators)', async () => {
    const payload = [
      'data: {"l"\n',
      'data: :1}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    // SSE spec: consecutive `data:` lines are joined with a newline.
    expect(await collect(payload)).toEqual(['{"l"\n:1}', '[DONE]'])
  })

  it('throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
    await expect(collect('data: {"type":"a"}\n\n')).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('handles payloads split across arbitrary byte boundaries', async () => {
    const text = 'data: {"type":"mixed","n":42}\n\ndata: [DONE]\n\n'
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream({
      start(controller) {
        // Enqueue in 3-byte fragments to force reassembly.
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3))
        controller.close()
      },
    })
    const out: string[] = []
    for await (const data of parseSse(stream as ReadableStream<BufferSource>)) out.push(data)
    expect(out).toEqual(['{"type":"mixed","n":42}', '[DONE]'])
  })
})
