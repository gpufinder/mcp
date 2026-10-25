#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { DEFAULT_URL, runProxy } from "./proxy.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }

const HELP = `gpufinder ${pkg.version} — live cloud GPU prices, stock and price history across 30+ providers.

Usage:
  npx -y gpufinder mcp      Start the GPU Finder MCP server over stdio (for Claude, Cursor, VS Code, Cline…)
  npx gpufinder --version   Print the version

Environment:
  GPUFINDER_API_KEY   Your API key. Free key (60 data calls a month): https://gpufinder.dev/developers
  GPUFINDER_MCP_URL   Override the endpoint (default ${DEFAULT_URL})
  GPUFINDER_DEBUG=1   Log requests to stderr (never the key)

Client config:
  { "mcpServers": { "gpufinder": {
      "command": "npx", "args": ["-y", "gpufinder", "mcp"],
      "env": { "GPUFINDER_API_KEY": "YOUR_API_KEY" } } } }

Docs: https://gpufinder.dev/api
`

async function main() {
  const command = process.argv[2]
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${pkg.version}\n`)
    return
  }
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP)
    return
  }
  // `gpufinder` with no argument starts the server when an MCP client launched it (stdin is a pipe).
  const startServer = command === "mcp" || (command === undefined && !process.stdin.isTTY)
  if (!startServer) {
    process.stderr.write(command === undefined ? HELP : `Unknown command: ${command}\n\n${HELP}`)
    process.exitCode = command === undefined ? 0 : 1
    return
  }

  const apiKey = process.env.GPUFINDER_API_KEY?.trim() || undefined
  const debug = process.env.GPUFINDER_DEBUG === "1"
  if (!apiKey) {
    process.stderr.write(
      "gpufinder: GPUFINDER_API_KEY is not set. Tools will list, but calls need a free key: https://gpufinder.dev/developers\n",
    )
  }
  await runProxy({
    input: process.stdin,
    output: process.stdout,
    url: process.env.GPUFINDER_MCP_URL?.trim() || DEFAULT_URL,
    apiKey,
    userAgent: `gpufinder-npm/${pkg.version} (+https://gpufinder.dev/api)`,
    log: debug ? (line) => process.stderr.write(`gpufinder: ${line}\n`) : undefined,
  })
}

main().catch((error: unknown) => {
  process.stderr.write(`gpufinder: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
