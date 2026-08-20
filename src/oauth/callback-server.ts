/**
 * One-shot local HTTP redirect server for the interactive OAuth browser flow.
 *
 * The OpenAI authorize page redirects the browser back to
 * `http://localhost:1455/auth/callback?code=...&state=...`. This server
 * validates the `state` (CSRF protection), captures the authorization code,
 * shows a small confirmation page, and returns the code. Host-only (Node http).
 *
 * @module dsh-openai-codex/oauth/callback-server
 */

/** Bytes for a minimal, dependency-free confirmation/error HTML page. */
const PAGE = (title: string, message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e6e6e6">
<div style="text-align:center"><h2>${title}</h2><p>${message}</p></div></body></html>`

/** Result of a completed callback. */
export interface OAuthCallbackResult {
  /** The authorization code returned by the identity provider. */
  code: string
}

export interface OAuthCallbackServer {
  /** Await the authorization code (resolves with the code, or resolves with null on error/cancel). */
  waitForCode(): Promise<OAuthCallbackResult | null>
  /** Stop the underlying HTTP server(s) and release the port. */
  close(): void
}

/**
 * Start a one-shot local HTTP server that receives the OAuth redirect.
 *
 * The redirect targets `localhost`, which the browser may resolve to either
 * loopback stack, so by default one server is bound on `127.0.0.1` and one on
 * `::1`; a bind failure on one stack is tolerated as long as the other
 * listens.
 *
 * @param state - the expected `state` value (rejects mismatches).
 * @param port - loopback port to bind (default 1455).
 * @param hosts - loopback hosts to bind (default 127.0.0.1 and ::1).
 * @returns a handle exposing the wait/cancel lifecycle.
 */
export function startCallbackServer(
  state: string,
  port = 1455,
  hosts: readonly string[] = ['127.0.0.1', '::1'],
): Promise<OAuthCallbackServer> {
  const nodeHttp = nodeHttpModule()
  type Server = ReturnType<typeof nodeHttp.createServer>
  let settle: ((value: OAuthCallbackResult | null) => void) | undefined
  const wait = new Promise<OAuthCallbackResult | null>((resolve) => {
    let settled = false
    settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  const servers: Server[] = []
  const requestHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(PAGE('Not found', 'Callback route not found.'))
        return
      }
      const receivedState = url.searchParams.get('state')
      if (receivedState !== state) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(PAGE('OAuth error', 'State mismatch — the authorization request was tampered with or the session expired.'))
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code.length === 0) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(PAGE('OAuth error', 'Missing authorization code.'))
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(PAGE('Done', 'OpenAI authentication completed. You can close this window.'))
      settle?.({ code })
    } catch {
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(PAGE('OAuth error', 'Internal error while processing the OAuth callback.'))
    }
  }
  return new Promise<OAuthCallbackServer>((resolve, reject) => {
    let ready = false
    let failures = 0
    const fail = (err: unknown) => {
      failures += 1
      if (!ready && failures === hosts.length) {
        settle?.(null)
        reject(err)
      }
    }
    for (const host of hosts) {
      const server = nodeHttp.createServer(requestHandler)
      servers.push(server)
      server
        .listen(port, host, () => {
          if (ready) return
          ready = true
          resolve({
            waitForCode: () => wait,
            close: () => {
              for (const s of servers) { try { s.close() } catch { /* server already closed */ } }
              settle?.(null)
            },
          })
        })
        .on('error', fail)
    }
  })
}

/** Lazily require Node `http`; throws a clear error outside Node. */
function nodeHttpModule(): { createServer: typeof import('node:http').createServer } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeHttp = globalThis.process?.versions?.node ? require('node:http') as { createServer: typeof import('node:http').createServer } : undefined
  if (nodeHttp === undefined) {
    throw new Error('OpenAI Codex callback server is only available in Node.js environments')
  }
  return nodeHttp
}
