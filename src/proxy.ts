import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

export const DEFAULT_URL = "https://gpufinder.dev/mcp"
const REQUEST_TIMEOUT_MS = 60_000

type JsonRpcId = string | number | null
type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export type ProxyOptions = {
  input: Readable
  output: Writable
  url?: string
  apiKey?: string
  userAgent: string
  log?: (line: string) => void
  fetchImpl?: typeof fetch
}

/**
 * stdio ⇄ Streamable HTTP proxy. Reads newline-delimited JSON-RPC from `input`,
 * POSTs each message to the GPU Finder MCP endpoint and writes the replies to
 * `output`. It forwards messages as they are, so the tool list always comes
 * from the server; it only answers `ping` locally and rewrites non-JSON-RPC
 * HTTP errors (401/429/5xx) into JSON-RPC replies for the waiting request.
 */
export function runProxy(options: ProxyOptions): Promise<void> {
  const url = options.url ?? DEFAULT_URL
  const doFetch = options.fetchImpl ?? fetch
  const log = options.log ?? (() => undefined)
  let protocolVersion: string | undefined
  let sessionId: string | undefined
  const pending = new Set<Promise<void>>()

  const write = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`)
  }

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": options.userAgent,
    }
    if (options.apiKey) h.Authorization = `Bearer ${options.apiKey}`
    if (protocolVersion) h["MCP-Protocol-Version"] = protocolVersion
    if (sessionId) h["Mcp-Session-Id"] = sessionId
    return h
  }

  const deliver = (message: JsonRpcMessage | JsonRpcMessage[]) => {
    for (const m of Array.isArray(message) ? message : [message]) {
      const result = m.result as { protocolVersion?: unknown } | undefined
      if (typeof result?.protocolVersion === "string") protocolVersion = result.protocolVersion
      write(m)
    }
  }

  const forward = async (message: JsonRpcMessage) => {
    const isRequest = message.id !== undefined && typeof message.method === "string"
    if (isRequest && message.method === "ping") {
      write({ jsonrpc: "2.0", id: message.id, result: {} })
      return
    }
    log(`→ ${message.method ?? "response"}${isRequest ? ` #${String(message.id)}` : ""}`)
    let response: Response
    let body: string
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      // The same timeout covers the body: fetch can resolve before a stream fails.
      body = await response.text()
    } catch (error) {
      if (isRequest) write(failure(message, 0, `Could not reach ${url}: ${errorText(error)}`))
      return
    }
    const newSession = response.headers.get("mcp-session-id")
    if (newSession) sessionId = newSession
    log(`← ${response.status} ${message.method ?? ""}`)

    if (!body.trim()) {
      if (isRequest) write(failure(message, response.status, `Empty HTTP ${response.status} response to ${message.method}`))
      return
    }
    const contentType = response.headers.get("content-type") ?? ""
    const parsed = contentType.includes("text/event-stream") ? parseSse(body) : parseJson(body)
    if (parsed !== undefined && isJsonRpc(parsed)) {
      deliver(parsed)
      return
    }
    if (isRequest) write(failure(message, response.status, serverMessage(parsed) ?? `HTTP ${response.status}`))
  }

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    for (const m of Array.isArray(message) ? message : [message]) {
      // Only client→server traffic is forwarded; the server sends no requests of its own.
      if (typeof (m as JsonRpcMessage)?.method !== "string") continue
      const task = forward(m as JsonRpcMessage)
      pending.add(task)
      // Attach both handlers immediately. A rejected forwarding task must never
      // become an unhandled rejection while stdin remains open.
      void task.then(() => pending.delete(task), () => pending.delete(task))
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input: options.input, crlfDelay: Infinity })
    lines.on("line", handleLine)
    lines.on("close", () => {
      void Promise.allSettled([...pending]).then(() => resolve())
    })
  })
}

/** A tool call gets an error *result* so the agent can read the guidance; other requests get a JSON-RPC error. */
function failure(request: JsonRpcMessage, status: number, text: string) {
  if (request.method === "tools/call") {
    return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }], isError: true } }
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: text, data: { status } } }
}

function isJsonRpc(value: unknown): value is JsonRpcMessage | JsonRpcMessage[] {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === "object" && first !== null && (first as JsonRpcMessage).jsonrpc === "2.0"
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** Collects the JSON payloads of every `data:` event in an SSE body. */
export function parseSse(body: string): JsonRpcMessage[] | undefined {
  const messages: JsonRpcMessage[] = []
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n")
    if (!data) continue
    const parsed = parseJson(data)
    if (Array.isArray(parsed)) messages.push(...(parsed as JsonRpcMessage[]))
    else if (parsed && typeof parsed === "object") messages.push(parsed as JsonRpcMessage)
  }
  return messages.length > 0 ? messages : undefined
}

function serverMessage(parsed: unknown): string | undefined {
  const error = (parsed as { error?: unknown } | undefined)?.error
  if (typeof error === "string") return error
  const message = (error as { message?: unknown } | undefined)?.message
  return typeof message === "string" ? message : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
