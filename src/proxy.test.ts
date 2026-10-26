import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseSse, runProxy } from "./proxy.js"

type Call = { url: string; headers: Record<string, string>; body: unknown }

/** Runs the proxy over in-memory streams against a fake fetch and returns what it wrote. */
async function run(lines: unknown[], reply: (body: any, call: Call) => Response, apiKey?: string) {
  const input = new PassThrough()
  const output = new PassThrough()
  const calls: Call[] = []
  const written: any[] = []
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) written.push(JSON.parse(line))
  })
  const fetchImpl = ((url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
    calls.push(call)
    return Promise.resolve(reply(call.body, call))
  }) as unknown as typeof fetch
  const done = runProxy({ input, output, apiKey, userAgent: "gpufinder-npm/test", fetchImpl })
  for (const line of lines) input.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`)
  input.end()
  await done
  return { calls, written }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("runProxy", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it.each(["tools/call", "tools/list"])("returns one correlated error for an empty successful %s response", async (method) => {
    const { written } = await run([{ jsonrpc: "2.0", id: "empty", method }], () => new Response(null, { status: 200 }))
    expect(written).toHaveLength(1)
    expect(written[0].id).toBe("empty")
    expect(method === "tools/call" ? written[0].result.isError : written[0].error.code).toBe(method === "tools/call" ? true : -32001)
    expect(JSON.stringify(written[0])).toContain("Empty HTTP 200")
  })

  it.each(["reset", "timeout"])("survives a body %s after headers and serves a later request on the same process", async (mode) => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("Body timed out", "TimeoutError")), ms)
      return controller.signal
    })
    const input = new PassThrough(), output = new PassThrough()
    const written: any[] = []
    output.on("data", (chunk: Buffer) => written.push(JSON.parse(chunk.toString())))
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      if (request.id === 2) return Promise.resolve(json({ jsonrpc: "2.0", id: 2, result: { tools: [] } }))
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        if (mode === "reset") controller.error(new Error("connection reset after headers"))
        else init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
      } }), { status: 200, headers: { "content-type": "application/json" } }))
    }) as typeof fetch
    const done = runProxy({ input, output, userAgent: "test", apiKey: "gpf_v1_secret", fetchImpl })
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" })}\n`)
    await vi.advanceTimersByTimeAsync(mode === "timeout" ? 60_000 : 0)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ id: 1, result: { isError: true } })
    expect(JSON.stringify(written[0])).not.toContain("gpf_v1_secret")
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
    await done
    expect(written).toHaveLength(2)
    expect(written[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } })
  })

  it("does not reply to a notification whose response body fails", async () => {
    const { written } = await run([{ jsonrpc: "2.0", method: "notifications/initialized" }], () =>
      new Response(new ReadableStream({ start(controller) { controller.error(new Error("reset")) } })),
    )
    expect(written).toEqual([])
  })

  it("forwards requests with the bearer key and user agent, and relays JSON-RPC replies", async () => {
    const { calls, written } = await run(
      [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
      (body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "list_gpus" }] } }),
      "gpf_v1_secret",
    )
    expect(calls[0].url).toBe("https://gpufinder.dev/mcp")
    expect(calls[0].headers.Authorization).toBe("Bearer gpf_v1_secret")
    expect(calls[0].headers["User-Agent"]).toBe("gpufinder-npm/test")
    expect(written).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_gpus" }] } }])
  })

  it("sends no Authorization header without a key", async () => {
    const { calls } = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }], (b) =>
      json({ jsonrpc: "2.0", id: b.id, result: { tools: [] } }),
    )
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it("adds the negotiated MCP-Protocol-Version after initialize", async () => {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    ]
    const { calls, written } = await run(input, (b) =>
      json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
    )
    expect(calls[0].headers["MCP-Protocol-Version"]).toBeUndefined()
    expect(written[0].result.protocolVersion).toBe("2025-06-18")
  })

  it("writes nothing for an accepted notification", async () => {
    const { calls, written } = await run(
      [{ jsonrpc: "2.0", method: "notifications/initialized" }],
      () => new Response(null, { status: 202 }),
    )
    expect(calls).toHaveLength(1)
    expect(written).toEqual([])
  })

  it("answers ping locally", async () => {
    const { calls, written } = await run([{ jsonrpc: "2.0", id: 7, method: "ping" }], () => json({}))
    expect(calls).toHaveLength(0)
    expect(written).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }])
  })

  it("turns a non-JSON-RPC 401 into an error result for tools/call with the server's guidance", async () => {
    const { written } = await run(
      [{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_usage", arguments: {} } }],
      () => json({ error: { code: "invalid_credential", message: "An API key is required. Keys are free." } }, 401),
    )
    expect(written).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "An API key is required. Keys are free." }], isError: true },
      },
    ])
  })

  it("turns a non-JSON-RPC error into a JSON-RPC error for other methods", async () => {
    const { written } = await run([{ jsonrpc: "2.0", id: 4, method: "resources/list" }], () =>
      json({ error: { message: "Too many requests" } }, 429),
    )
    expect(written[0]).toMatchObject({ id: 4, error: { code: -32001, message: "Too many requests", data: { status: 429 } } })
  })

  it("reports an unreachable endpoint without leaking the key", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ""
    output.on("data", (c: Buffer) => (text += c.toString()))
    const failing = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch
    const done = runProxy({ input, output, apiKey: "gpf_v1_secret", userAgent: "t", fetchImpl: failing })
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`)
    await done
    expect(JSON.parse(text).error.message).toContain("ENOTFOUND")
    expect(text).not.toContain("gpf_v1_secret")
  })

  it("relays messages from an SSE response", async () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })}\n\n`
    const { written } = await run(
      [{ jsonrpc: "2.0", id: 2, method: "tools/list" }],
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    )
    expect(written).toEqual([{ jsonrpc: "2.0", id: 2, result: { ok: true } }])
  })

  it("returns a parse error for invalid JSON input", async () => {
    const { written } = await run(["{not json"], () => json({}))
    expect(written).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }])
  })
})

describe("parseSse", () => {
  it("returns undefined when there are no data events", () => {
    expect(parseSse(": keep-alive\n\n")).toBeUndefined()
  })
})
