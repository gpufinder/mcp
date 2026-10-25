# Installing the GPU Finder MCP server (for AI agents)

These steps are for an AI agent such as Cline setting up this server for a user.

## 1. Requirements

- Node.js 20 or newer (`node -v`). Nothing else: the package has no runtime dependencies and nothing needs cloning or building.

## 2. Get an API key

Ask the user for their GPU Finder API key. If they do not have one, they can create a free key
(60 data calls a month) at https://gpufinder.dev/developers. Without a key the server still starts and
lists its tools, but every tool call returns an error asking for a key.

## 3. Add the server to the MCP settings

Add this entry to the client's MCP settings file (for Cline: `cline_mcp_settings.json`), replacing
`YOUR_API_KEY` with the user's key:

```json
{
  "mcpServers": {
    "gpufinder": {
      "command": "npx",
      "args": ["-y", "gpufinder", "mcp"],
      "env": { "GPUFINDER_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

On Windows, if `npx` is not found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "gpufinder", "mcp"]`.

## 4. Verify

Call the `get_usage` tool. It costs nothing and returns the key's plan and monthly usage. A
`401` error means the key is missing or wrong.

Then try a data call, for example `get_market_snapshot` for `h100` with a count of 8
("cheapest 8× H100 in stock right now").

## Tools

All read-only: `list_gpus`, `list_providers`, `get_prices`, `get_market_snapshot`, `get_availability`,
`get_price_history`, `get_data_status`, `get_usage`. Each data call uses one unit of the monthly
allowance; listing tools and `get_usage` are free.

## Troubleshooting

- Set `"GPUFINDER_DEBUG": "1"` in `env` to log requests to stderr (the key is never logged).
- Docs: https://gpufinder.dev/api
