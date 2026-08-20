/**
 * Advisory model catalog for the OpenAI Codex provider.
 *
 * The codex subscription allows its ChatGPT-geared models. Streaming is
 * unrestrained (like llm-deepseek): an unlisted model id still streams; the
 * catalog only feeds discovery consumers (the web model picker). The defaults
 * here track the models opencode's codex plugin exposes; users can override
 * the catalog through plugin config.
 *
 * @module dsh-openai-codex/oauth/models
 */

/** One catalog model entry, mirroring llm-deepseek's `DeepSeekCatalogModel`. */
export interface CodexCatalogModel {
  /** Wire model id sent in the request body. */
  id: string
  /** Selector label; defaults to `id`. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known request/response context capacity (tokens). */
  contextWindow?: number
  /** Per-request output cap; omission falls back to config maxTokens. */
  maxTokens?: number
}

export const DEFAULT_CODEX_CONTEXT_WINDOW = 400_000
export const DEFAULT_CODEX_MAX_TOKENS = 128_000

/** Default catalog shown to discovery consumers (advisory, not exhaustive). */
export const DEFAULT_CODEX_MODELS: readonly CodexCatalogModel[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Latest codex flagship model', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
  { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Codex GPT-5.4', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Faster, more compact codex model', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: 'Fast spark-tier codex model', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
  { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Codex GPT-5.2', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
  { id: 'gpt-5-4-mini', name: 'GPT-5-4 Mini', description: 'Alternative compact codex variant', contextWindow: 400_000, maxTokens: DEFAULT_CODEX_MAX_TOKENS },
]
