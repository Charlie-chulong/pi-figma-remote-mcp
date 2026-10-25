> Made @ Shopify

# pi-figma-remote-mcp

Connects [pi-coding-agent](https://github.com/badlogic/pi-mono) to the Figma remote MCP server.

Uses OAuth2 to authenticate with `https://mcp.figma.com/mcp`. No Figma desktop app required — works with browser-based Figma.

## When to use this vs pi-figma-mcp

| | pi-figma-mcp (desktop) | pi-figma-remote-mcp |
|---|---|---|
| Requires desktop app | Yes | No |
| Auth | None | OAuth2 |
| `generate_figma_design` | No | Yes |
| `create_new_file` | No | Yes |
| `use_figma` writes | No (use figma-labor bridge) | Yes |

Use the desktop extension (`pi-figma-mcp`) for day-to-day work with the bridge.
Use this extension when you need remote-only features or don't have the desktop app.

## Install

Message `pi`:

```
Install this pi-extension https://github.com/mkaralevich/pi-figma-remote-mcp
```

Or place extension in your `/extensions` folder.

## Use

1. Run `/figma-remote-auth` to authenticate (opens browser for Figma OAuth)
2. Footer shows `figma-remote ✓` when connected
3. Give pi a link to a frame

Token is saved to `~/.pi/figma-remote-mcp-token.json` and auto-refreshes.

> **Note:** Figma's dynamic client registration endpoint is whitelisted by `client_name`. This extension registers as `"Claude Code"` to pass registration. Custom names get 403 Forbidden.

## Commands

| Command | Description |
|---|---|
| `/figma-remote` | Show connection status and available tools |
| `/figma-remote-auth` | Run OAuth authentication |

[Showing lines 1-47 of 59. Use :48 to continue]

## OMP compatibility

The schema builder passes descriptions through TypeBox constructor options rather
than spreading schema values. This preserves callable schemas in OMP 18.12.3's
TypeBox compatibility layer and avoids `asRuntime(schema).or is not a function`
when registering tools with optional described parameters. It remains compatible
with the existing TypeBox constructor API.

This change does not modify OAuth registration, client identifiers, callback
URLs, token handling, MCP requests, or canvas execution. Existing running
sessions must reload the extension to pick up the changed module; logging in
again is not required solely for this fix.

### Native OMP regression check

`test/omp-schema.regression.ts` calls the actual exported `buildSchema` and checks
required/optional fields, invalid JSON value types, enum rejection, and parameter
descriptions. Importing it does not start OAuth or connect to Figma.

Load that file as an explicit `--trusted-extension` in an isolated native OMP
RPC process, then send a local `get_state` request and close stdin. The trusted
extension option makes assertion failures fail startup rather than silently
dropping the test extension. No model prompt is needed.

Validation on OMP 18.12.3: 16 regression assertions passed; a separate live,
read-only smoke registered all 42 currently advertised tools and successfully
called `whoami` and `get_metadata` using an existing authorization. Canvas writes
and the remaining remote tools were not exercised.
