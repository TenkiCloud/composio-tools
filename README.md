# @tenkicloud/composio-tools

Tenki sandbox tools for [Composio](https://composio.dev) agents. Gives any Composio agent disposable Linux microVMs from [Tenki](https://tenki.cloud) — boot in ~2–4 seconds, run shell commands, snapshot state, and terminate — via Composio's [custom toolkits](https://docs.composio.dev/docs/extending-sessions/custom-tools-and-toolkits).

The tools run **in-process in your app** and call the Tenki SDK directly. No extra backend, no Composio approval needed.

## Install

```bash
npm install @tenkicloud/composio-tools @composio/core
```

`@composio/core` is a peer dependency (>= 0.13.0). Requires Node >= 18.

## Quickstart

```ts
import { Composio } from '@composio/core';
import { tenkiToolkit } from '@tenkicloud/composio-tools';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

const session = await composio.create('user_1', {
  experimental: { customToolkits: [tenkiToolkit()] },
});

// The agent can now call:
//   LOCAL_TENKI_CREATE_SANDBOX
//   LOCAL_TENKI_EXEC_COMMAND
//   LOCAL_TENKI_LIST_SANDBOXES
//   LOCAL_TENKI_GET_SANDBOX
//   LOCAL_TENKI_CREATE_SNAPSHOT
//   LOCAL_TENKI_TERMINATE_SANDBOX
```

> Note: toolkits bind via `experimental.customToolkits` (standalone tools use `experimental.customTools`).

Authentication: set `TENKI_API_KEY` in your environment (get one at [app.tenki.cloud](https://app.tenki.cloud)), or pass `authToken` explicitly. The workspace/project for new sandboxes is resolved automatically from the key's identity; override with `TENKI_WORKSPACE_ID` / `TENKI_PROJECT_ID` env vars or factory options.

## Configuration

```ts
tenkiToolkit({
  authToken: 'tk_…',            // default: TENKI_API_KEY env var
  workspaceId: '…',             // default: TENKI_WORKSPACE_ID env var, else first visible workspace
  projectId: '…',               // default: TENKI_PROJECT_ID env var, else first project in workspace
  preload: true,                // expose tools in session.tools() without searching first
  bootTimeoutMs: 120_000,       // creation + readiness budget; failed boots are terminated, not leaked
  defaults: {                   // applied to CREATE_SANDBOX when the agent omits them
    cpuCores: 4,
    memoryMb: 8192,
    allowOutbound: true,
    maxDurationMs: 30 * 60_000, // hard backstop: VM self-terminates even if the host crashes
  },
});
```

## Tools

| Tool | Input | Returns |
|------|-------|---------|
| `LOCAL_TENKI_CREATE_SANDBOX` | `name?`, `cpuCores?`, `memoryMb?`, `allowOutbound?`, `image?`, `snapshotId?`, `env?` (array of `{name, value}`), `maxDurationMinutes?` (default 30) | `sessionId`, specs, state, `bootTimeMs` |
| `LOCAL_TENKI_EXEC_COMMAND` | `sessionId`, `command`, `timeoutSeconds?` (default 30, max 600) | `exitCode`, `stdout`, `stderr`, `durationMs` (output truncated ~12KB/4KB for LLM context) |
| `LOCAL_TENKI_LIST_SANDBOXES` | `state?` (filter) | `count`, `sandboxes[]` with id/name/state/specs |
| `LOCAL_TENKI_GET_SANDBOX` | `sessionId` | full detail incl. state, networking, expiry |
| `LOCAL_TENKI_CREATE_SNAPSHOT` | `sessionId`, `name?` | `snapshotId` (usable in `CREATE_SANDBOX.snapshotId`) |
| `LOCAL_TENKI_TERMINATE_SANDBOX` | `sessionId` | idempotent; `alreadyTerminated` flag |

Behavior notes: every tool returns structured JSON and never throws — SDK errors come back as `{ success: false, error: { type, message } }` so the agent can react. `EXEC_COMMAND` requires an existing `sessionId` (no implicit sandbox creation). Outbound internet is controlled by `allowOutbound`; when omitted, your Tenki **workspace defaults** apply — check `outboundNetworking` in the `CREATE_SANDBOX` response.

Lifecycle guarantees: `CREATE_SANDBOX` is **failure-atomic** — the session handle is held before waiting for readiness, so a boot that fails or exceeds `bootTimeoutMs` is terminated, never leaked. Every sandbox gets a **max-duration backstop** (default 30 min, override via `maxDurationMinutes` or `defaults.maxDurationMs`) so microVMs self-terminate even if the host process crashes before calling `TERMINATE_SANDBOX`. Readiness is detected by polling unary `refresh()` rather than the streaming `waitReady()` RPC, which some runtimes (e.g. Bun's `node:http2`) close prematurely.

## Security

- `TENKI_API_KEY` grants control over your Tenki workspace — keep it in the host environment, never inside sandboxes.
- Tools run in-process in *your* application (the host you run the Composio session from), not on Composio's servers.
- The agent decides what commands to run; the sandbox is your isolation boundary. Set `allowOutbound: false` explicitly (per call or via `defaults`) if your workspace default is open and the task doesn't need network.

## How it works

Custom tools are **session-scoped**: `tenkiToolkit()` returns a `CustomToolkit` whose `execute` functions run in your process and call the Tenki SDK. Composio prefixes the slugs (`CREATE_SANDBOX` → `LOCAL_TENKI_CREATE_SANDBOX`) and routes agent tool calls back to your process via `session.execute()`. Because execution is session-bound, drive these tools through the session object — `provider.handleToolCalls()` (global execute path) cannot reach them; see `scripts/agent-test.ts` for a working agentic loop.

## Development

```bash
pnpm install
pnpm test          # vitest unit tests (Tenki SDK mocked — no network, no keys needed)
pnpm build         # tsup → dist/ (ESM + CJS + d.ts)
pnpm typecheck
pnpm format:check
```

Live verification (needs a `.env` with real keys — see the script headers):

```bash
pnpm smoke   # drives all six tools through a real Composio session: create → exec → snapshot → terminate
pnpm agent   # Claude autonomously boots, inspects, and terminates a sandbox (needs ANTHROPIC_API_KEY)
```

Both scripts terminate every microVM they create (even on failure) and `smoke` deletes its test snapshot.

## License

MIT
