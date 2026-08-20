# dsh-openai-codex

**OpenAI Codex (ChatGPT subscription) authentication and LLM provider for
[deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/).**

This plugin adds:

1. A **Settings card** (web) with a **“Sign in with OpenAI Codex”** button —
   OAuth against `auth.openai.com`, backed by your ChatGPT/Codex subscription.
2. The **`codex` LLM provider**, exposing subscription models (e.g.
   `gpt-5.5`) to any model-routing configuration in DSH.

There is no API key to paste: the plugin performs the same OAuth sign-in flow
as the Codex CLI (browser or device code), then keeps the credential refreshed
in DSH's own credential store.

---

## Install

From inside a DSH profile directory (or with `--profile`), add the plugin
bundle:

```bash
dsh plugin --profile <name> add ./dsh-openai-codex
```

This consumes the bundle's patch (`cordis.patch.yml`), installing the
`openai-codex` plugin and wiring its client (Settings card). After install,
refresh the web GUI.

## Authenticate

1. Open **Settings → Plugins** (or the provider settings card).
2. In the **OpenAI Codex** card, click **Sign in with OpenAI Codex**.
   - A browser tab opens to `auth.openai.com` (interactive login). Or use
     **Device code** to get a one-time code to enter at
     `https://auth.openai.com/codex/device`.
3. Grant access; the plugin stores the OAuth credential envelope in DSH's
   credential store (`$DSH_HOME/.credentials.yaml`). The **account id** is
   derived from the access-token JWT and used for the `chatgpt-account-id`
   header.

On sign-out, the stored credential is cleared.

## Use the provider

Select provider `codex` and a model in your model-routing config, e.g. in
`cordis.yml`:

```yaml
llm:
  routes:
    - provider: codex
      model: gpt-5.5
```

Available catalog models (configurable under the `openai-codex` settings
namespace): `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`,
`gpt-5.2`, `gpt-5-4-mini`.

### Configuration

All keys live under the plugin's settings namespace. With `openai-codex`
scoped globally, you can set defaults directly:

```yaml
openai-codex:
  # Reasoning effort applied when a request omits one.
  reasoningEffort: high   # off | low | medium | high | max
  # Default output budget.
  maxTokens: 128000
  # Advisory context window for models without an exact catalog value.
  defaultContextWindow: 400000
  # Text verbosity.
  verbosity: low          # low | medium | high
  # Refresh the access token this far before expiry.
  refreshBeforeMs: 300000
  # Drop an in-flight request after this much provider idle time.
  streamIdleTimeoutMs: 30000
  # Strip model-emitted redundant `sandbox_permissions: "workspace-write"` from
  # tool calls before the harness sees them (kept when a sandbox denial in the
  # conversation makes it a legitimate retry; genuine escalations preserved).
  sanitizeSandboxPermissions: true
  # Override the codex Responses endpoint (advanced/debugging).
  baseURL: https://chatgpt.com/backend-api/codex/responses
```

Unset optional keys (`reasoningEffort`, `verbosity`, `retryPolicy`) fall back
to provider defaults.

## How it works

- **Host half** (`src/index.ts`): registers the `codex` LLM adapter + a
  configurable provider, the credential store (`OPENAI_CODEX_CREDENTIAL`), a
  settings namespace, and an RPC channel (`/rpc-codex`) the Settings card calls
  to start/poll OAuth.
- **Client half** (`src/client`): a React card injected into
  `settings.plugin.item`; talks to the Host through the generic Connection RPC
  bridge (`authority: loopback`).
- **OAuth** (`src/oauth`): PKCE `S256`; interactive browser redirect to
  `http://127.0.0.1:1455/auth/callback` or the device-code flow; token refresh
  via the `refresh_token` grant.
- **Codex wire** (`src/codex`): `POST /backend-api/codex/responses`, SSE, parsed
  with `eventsource-parser`; Responses events are translated into harness
  `StreamChunk`s (text / reasoning / tool-call blocks, usage-before-finish).

## Development

This checkout is a standalone package whose `@deepseek-ai/*` peer deps resolve
from a **deepseek-harness checkout** when installed into a profile (via
`dsh plugin add`), and from that same checkout's `node_modules` (symlinked under
`node_modules/`) when building/testing locally. The `.npmrc` sets
`verify-deps-before-run=false` so pnpm doesn't try to re-install the peer deps
here — do not run `pnpm install` in this directory expecting it to fetch them
from npm.

```bash
pnpm build       # emits lib/index.js (Host ESM) + lib/client.js (browser bundle)
pnpm typecheck   # tsc --noEmit over src + tests
pnpm test        # vitest run (unit tests)
```

> Before the first local build/typecheck/test, `node_modules` must expose the
> toolchain and the `@deepseek-ai/*` sources. Recreate the symlink farm once,
> pointing at your deepseek-harness checkout:
>
> ```bash
> scripts/setup-local-dev.sh /absolute/path/to/deepseek-harness
> ```
>
> The build ships the prebuilt `lib/`, so end users installing via `dsh plugin
> add` never need to build.

The browser client bundle artifact is the loader-wrapped CJS
(`window.__ModuleLoader__.load({ id, factory: (require) => … })`) the
client-module system serves at `/plugins/dsh-openai-codex/client.js`.

### Layout

```
src/index.ts            Host plugin entry (apply)
src/oauth/              PKCE, JWT account-id, callback server, OAuth flows
src/codex/              Responses wire: types, serialization, SSE, translate
src/codex/adapter.ts    LlmAdapter implementing stream/listModels/resolveModel
src/client/             Settings card, RPC bridge, locales
test/                   unit tests (vitest)
```

## Notes / caveats

- The interactive login binds a localhost port (`1455`) to catch the OAuth
  redirect. A firewall or container can prevent this; the **device-code** flow
  is the portable fallback.
- Codex streams are long-lived; the adapter ties liveness to a per-request
  idle timeout and honors DSH's request abort signal.
- OAuth token expiry cannot be observed by this plugin in this environment;
  expiry is derived from the issued `expires_in`, and refresh is re-attempted
  pre-emptively before each request near expiry.
