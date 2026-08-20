/**
 * Decode an SSE byte stream into codex Responses `data` payloads. Framing —
 * chunk reassembly, UTF-8/CRLF handling, multi-`data:` joining — is handled by
 * `eventsource-parser`. Codex terminates with `[DONE]`; EOF before it is
 * truncation and raises {@link LlmError} (`STREAM_CLOSED`), the same contract
 * llm-deepseek's parser enforces.
 *
 * @module dsh-openai-codex/codex/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload codex/OpenAI send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payload strings.
 * @param stream - raw SSE bytes; reads may split anywhere.
 * @param onComment - optional transport-activity callback.
 * @returns each event's data payload in arrival order; ends after the `[DONE]`
 * sentinel or a terminal response event — whichever the backend sends.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
    // The codex backend ends a turn with a terminal response event and then
    // closes the stream without a `[DONE]` sentinel; EOF after one is a
    // normal end, not truncation.
    if (isTerminalEvent(data)) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/** Terminal Responses event types that end a turn without a `[DONE]` sentinel. */
const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
])

/** Whether one SSE data payload is a terminal response event. */
function isTerminalEvent(data: string): boolean {
  if (!data.startsWith('{')) return false
  try {
    const type = (JSON.parse(data) as { type?: unknown }).type
    return typeof type === 'string' && TERMINAL_EVENT_TYPES.has(type)
  } catch {
    return false
  }
}
