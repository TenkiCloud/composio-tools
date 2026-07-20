/**
 * Tenki custom toolkit for Composio.
 *
 * Gives Composio agents disposable Linux microVMs from Tenki (https://tenki.cloud):
 * create a sandbox, run shell commands, snapshot it, and terminate it — all
 * through Composio's custom-toolkit API. Tools run in-process in your app and
 * call the Tenki SDK directly, so no extra backend is involved.
 *
 * Usage:
 * ```ts
 * import { Composio } from '@composio/core';
 * import { tenkiToolkit } from '@tenkicloud/composio-tools';
 *
 * const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
 * const session = await composio.create('user_1', {
 *   experimental: { customToolkits: [tenkiToolkit()] },
 * });
 * // Agent can now call LOCAL_TENKI_CREATE_SANDBOX, LOCAL_TENKI_EXEC_COMMAND, ...
 * ```
 */
import { experimental_createTool, experimental_createToolkit } from '@composio/core';
import type { CustomToolkit } from '@composio/core';
import {
  TenkiSandbox,
  SandboxError,
  SessionNotFoundError,
  SessionTerminatedError,
  isReady,
  isTerminal,
  stdoutText,
  stderrText,
  type Session,
  type Snapshot,
} from '@tenkicloud/sandbox';
import { z } from 'zod/v3';

/** Options for {@link tenkiToolkit}. All optional; env vars fill the gaps. */
export interface TenkiToolkitOptions {
  /** Tenki API key. Defaults to the TENKI_API_KEY environment variable. */
  authToken?: string;
  /** Override the Tenki API base URL (rarely needed). */
  baseUrl?: string;
  /** Workspace to create sandboxes in. Defaults to TENKI_WORKSPACE_ID, else the first workspace visible to the key. */
  workspaceId?: string;
  /** Project to create sandboxes in. Defaults to TENKI_PROJECT_ID, else the first project in the resolved workspace. */
  projectId?: string;
  /** When true, expose the tools in session.tools() without the agent having to search first. */
  preload?: boolean;
  /** Budget for sandbox creation + readiness in CREATE_SANDBOX. A boot that exceeds it is terminated, not leaked. Default 120s. */
  bootTimeoutMs?: number;
  /** Default sandbox specs applied to CREATE_SANDBOX when the agent omits them. */
  defaults?: {
    cpuCores?: number;
    memoryMb?: number;
    diskSizeGb?: number;
    allowOutbound?: boolean;
    image?: string;
    /** Hard backstop: the microVM self-terminates after this duration even if the host process crashes before TERMINATE_SANDBOX runs. Default 30 minutes. */
    maxDurationMs?: number;
  };
}

/** Structured error shape returned to the agent instead of a thrown exception. */
interface ToolError {
  type: string;
  message: string;
}

type ToolResult = Record<string, unknown>;

/** Output larger than this is truncated so it stays affordable in LLM context. */
const MAX_STDOUT_CHARS = 12_000;
const MAX_STDERR_CHARS = 4_000;

const DEFAULT_EXEC_TIMEOUT_SECONDS = 30;
const MAX_EXEC_TIMEOUT_SECONDS = 600;

/** Creation + readiness budget for CREATE_SANDBOX. */
const DEFAULT_BOOT_TIMEOUT_MS = 120_000;
/** Host-crash backstop: sandboxes self-terminate after this unless overridden. */
const DEFAULT_MAX_DURATION_MS = 30 * 60_000;
const READY_POLL_INTERVAL_MS = 500;

/**
 * Poll until the session accepts commands, using unary calls only.
 * (`session.waitReady()` uses a server-streaming RPC that some runtimes —
 * e.g. Bun's node:http2 — close prematurely; polling `refresh()` is
 * runtime-agnostic.)
 */
async function waitUntilReady(session: Session, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await session.refresh();
    if (isReady(session.state)) return;
    if (isTerminal(session.state)) {
      throw new Error(`Sandbox entered terminal state ${session.state} while booting.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Sandbox not ready after ${timeoutMs}ms (state: ${session.state}).`);
    }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

function describeError(error: unknown): ToolError {
  if (error instanceof SandboxError || error instanceof Error) {
    return { type: error.name || error.constructor.name, message: error.message };
  }
  return { type: 'UnknownError', message: String(error) };
}

/** Wrap a tool body so it always returns structured JSON and never throws raw SDK errors. */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return { success: true, ...(await fn()) };
  } catch (error) {
    return { success: false, error: describeError(error) };
  }
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const omitted = text.length - max;
  return { text: `${text.slice(0, max)}\n… [truncated ${omitted} characters]`, truncated: true };
}

function toIso(value: Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined;
}

function sessionSummary(session: Session): ToolResult {
  return {
    sessionId: session.id,
    name: session.name,
    state: session.state,
    cpuCores: session.cpuCores,
    memoryMb: session.memoryMb,
    diskSizeGb: session.diskSizeGb,
  };
}

function sessionDetail(session: Session): ToolResult {
  return {
    ...sessionSummary(session),
    projectId: session.projectId,
    outboundNetworking: session.outboundEnabled,
    expiresAt: toIso(session.timeoutAt),
    idleTimeoutMinutes: session.idleTimeoutMinutes,
    tags: session.tags,
  };
}

function snapshotSummary(snapshot: Snapshot): ToolResult {
  return {
    snapshotId: snapshot.id,
    sessionId: snapshot.sessionId,
    name: snapshot.name,
    state: snapshot.state,
    sizeBytes: snapshot.sizeBytes,
    createdAt: toIso(snapshot.createdAt),
  };
}

/**
 * Create the Tenki custom toolkit.
 *
 * Pass the result to `composio.create(userId, { experimental: { customToolkits: [tenkiToolkit()] } })`.
 * The Tenki client is created lazily on first tool call, so constructing the
 * toolkit never throws — a missing TENKI_API_KEY surfaces as a structured
 * `{ success: false, error }` result on the first call instead.
 */
export function tenkiToolkit(options: TenkiToolkitOptions = {}): CustomToolkit {
  let client: TenkiSandbox | undefined;
  let target: { workspaceId: string; projectId: string } | undefined;

  const getClient = (): TenkiSandbox => {
    client ??= new TenkiSandbox({
      ...(options.authToken ? { authToken: options.authToken } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    return client;
  };

  /**
   * Resolve the workspace/project pair required by session creation.
   * Explicit options win, then TENKI_WORKSPACE_ID / TENKI_PROJECT_ID env vars,
   * then the first workspace/project visible to the API key (via whoAmI).
   * Cached after the first resolution.
   */
  const resolveTarget = async (): Promise<{ workspaceId: string; projectId: string }> => {
    if (target) return target;

    const workspaceOverride = options.workspaceId ?? process.env.TENKI_WORKSPACE_ID;
    const projectOverride = options.projectId ?? process.env.TENKI_PROJECT_ID;

    if (workspaceOverride && projectOverride) {
      target = { workspaceId: workspaceOverride, projectId: projectOverride };
      return target;
    }

    const identity = await getClient().whoAmI();
    const workspace =
      identity.workspaces.find(ws => ws.id === workspaceOverride) ?? identity.workspaces[0];
    const project =
      workspace?.projects.find(p => p.id === projectOverride) ?? workspace?.projects[0];
    if (!workspace || !project) {
      throw new Error(
        'No Tenki workspace/project is visible for this API key. ' +
          'Set TENKI_WORKSPACE_ID and TENKI_PROJECT_ID, or pass workspaceId/projectId to tenkiToolkit().'
      );
    }

    target = { workspaceId: workspace.id, projectId: project.id };
    return target;
  };

  const createSandbox = experimental_createTool('CREATE_SANDBOX', {
    name: 'Create Sandbox',
    description:
      'Create a fresh, isolated Linux microVM (Tenki sandbox) and wait until it is ready to accept commands (~2-4s). ' +
      'Use this before EXEC_COMMAND when you need a safe environment to run code, install packages, or test commands. ' +
      'Returns the sessionId required by all other TENKI tools. Outbound internet access is controlled by allowOutbound (workspace defaults apply when omitted) — check outboundNetworking in the response. ' +
      'Sandboxes self-terminate after maxDurationMinutes (default 30) as a safety backstop.',
    inputParams: z.object({
      name: z.string().max(100).optional().describe('Human-readable sandbox name.'),
      cpuCores: z.number().int().min(1).max(16).optional().describe('vCPU count. Default 2.'),
      memoryMb: z
        .number()
        .int()
        .min(512)
        .max(65_536)
        .optional()
        .describe('Memory in MB. Default 4096.'),
      allowOutbound: z
        .boolean()
        .optional()
        .describe(
          'Enable outbound internet access from inside the sandbox (needed for apt/pip/npm installs or API calls). Default false.'
        ),
      image: z.string().optional().describe('Image to boot. Omit for the default Ubuntu image.'),
      snapshotId: z
        .string()
        .optional()
        .describe(
          'Restore from an existing snapshot (created via CREATE_SNAPSHOT) instead of booting a fresh image.'
        ),
      // NOTE: an array of {name, value} pairs, not a record — Composio's backend
      // rejects JSON-schema object fields that have no fixed `properties`.
      env: z
        .array(
          z.object({
            name: z.string().min(1).describe('Environment variable name, e.g. NODE_ENV.'),
            value: z.string().describe('Environment variable value.'),
          })
        )
        .optional()
        .describe('Environment variables to set inside the sandbox.'),
      maxDurationMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .optional()
        .describe(
          'Hard lifetime limit in minutes; the sandbox self-terminates after this even if never explicitly terminated. Default 30.'
        ),
    }),
    execute: async input =>
      run(async () => {
        const { workspaceId, projectId } = await resolveTarget();
        const startedAt = Date.now();
        // Failure-atomic boot: take the session handle *before* waiting for
        // readiness, so a failed or timed-out boot is terminated instead of
        // leaking a running microVM. maxDurationMs is the backstop for the
        // host-crash/SIGKILL case, where no cleanup code runs at all.
        const session = await getClient().create({
          workspaceId,
          projectId,
          maxDurationMs: DEFAULT_MAX_DURATION_MS,
          ...(options.defaults ?? {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.cpuCores !== undefined ? { cpuCores: input.cpuCores } : {}),
          ...(input.memoryMb !== undefined ? { memoryMb: input.memoryMb } : {}),
          ...(input.allowOutbound !== undefined ? { allowOutbound: input.allowOutbound } : {}),
          ...(input.image !== undefined ? { image: input.image } : {}),
          ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
          ...(input.env !== undefined
            ? { env: Object.fromEntries(input.env.map(e => [e.name, e.value])) }
            : {}),
          ...(input.maxDurationMinutes !== undefined
            ? { maxDurationMs: input.maxDurationMinutes * 60_000 }
            : {}),
          waitReady: false,
        });
        try {
          await waitUntilReady(session, options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);
        } catch (error) {
          // Best-effort cleanup; never mask the original boot error.
          await session.closeIfOpen().catch(() => {});
          throw error;
        }
        return { ...sessionDetail(session), bootTimeMs: Date.now() - startedAt };
      }),
  });

  const execCommand = experimental_createTool('EXEC_COMMAND', {
    name: 'Execute Command',
    description:
      'Run a shell command inside an existing Tenki sandbox (executed with `bash -lc`, so pipes, globs, and && work). ' +
      'Requires a sessionId from CREATE_SANDBOX or LIST_SANDBOXES — this tool never creates sandboxes implicitly. ' +
      `Returns exitCode, stdout, and stderr (output beyond ~${MAX_STDOUT_CHARS} characters is truncated).`,
    inputParams: z.object({
      sessionId: z
        .string()
        .min(1)
        .describe('ID of a running sandbox, as returned by CREATE_SANDBOX or LIST_SANDBOXES.'),
      command: z
        .string()
        .min(1)
        .describe("Shell command to run, e.g. 'python3 --version' or 'ls -la /home'."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_EXEC_TIMEOUT_SECONDS)
        .optional()
        .describe(
          `Command timeout in seconds. Default ${DEFAULT_EXEC_TIMEOUT_SECONDS}, max ${MAX_EXEC_TIMEOUT_SECONDS}.`
        ),
    }),
    execute: async input =>
      run(async () => {
        const session = await getClient().get(input.sessionId);
        const timeoutMs = (input.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000;
        const result = await session.exec('bash', { args: ['-lc', input.command], timeoutMs });
        const stdout = truncate(stdoutText(result), MAX_STDOUT_CHARS);
        const stderr = truncate(stderrText(result), MAX_STDERR_CHARS);
        return {
          exitCode: result.exitCode,
          status: result.status,
          durationMs: result.durationMs,
          stdout: stdout.text,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated,
        };
      }),
  });

  const listSandboxes = experimental_createTool('LIST_SANDBOXES', {
    name: 'List Sandboxes',
    description:
      'List the Tenki sandboxes visible to the configured API key, with their sessionId, name, state ' +
      '(e.g. RUNNING, PAUSED, TERMINATED), and specs. Use it to find an existing sandbox to reuse or clean up.',
    inputParams: z.object({
      state: z
        .enum(['CREATING', 'RUNNING', 'PAUSED', 'TERMINATED'])
        .optional()
        .describe('Only return sandboxes in this state. Omit to return all sandboxes.'),
    }),
    execute: async input =>
      run(async () => {
        const sessions = await getClient().list();
        const filtered = input.state ? sessions.filter(s => s.state === input.state) : sessions;
        return { count: filtered.length, sandboxes: filtered.map(sessionSummary) };
      }),
  });

  const getSandbox = experimental_createTool('GET_SANDBOX', {
    name: 'Get Sandbox',
    description:
      'Get the current state and full details of one Tenki sandbox by sessionId: state, specs, ' +
      'networking, and expiry. Use it to check a sandbox is still RUNNING before executing commands.',
    inputParams: z.object({
      sessionId: z.string().min(1).describe('ID of the sandbox to inspect.'),
    }),
    execute: async input =>
      run(async () => {
        const session = await getClient().get(input.sessionId);
        return sessionDetail(session);
      }),
  });

  const createSnapshot = experimental_createTool('CREATE_SNAPSHOT', {
    name: 'Create Snapshot',
    description:
      'Snapshot the full state of a running Tenki sandbox (filesystem + memory) and wait until it is ready. ' +
      'The returned snapshotId can be passed to CREATE_SANDBOX to restore an identical environment later. ' +
      'Use it to checkpoint work before risky operations or to persist a configured environment.',
    inputParams: z.object({
      sessionId: z.string().min(1).describe('ID of the sandbox to snapshot.'),
      name: z.string().max(100).optional().describe('Human-readable snapshot name.'),
    }),
    execute: async input =>
      run(async () => {
        const snapshot = await getClient().createSnapshotAndWait(input.sessionId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        return snapshotSummary(snapshot);
      }),
  });

  const terminateSandbox = experimental_createTool('TERMINATE_SANDBOX', {
    name: 'Terminate Sandbox',
    description:
      'Terminate a Tenki sandbox and release its resources. Always call this when you are done with a sandbox. ' +
      'Idempotent: terminating an already-terminated or missing sandbox succeeds with alreadyTerminated=true. ' +
      'Termination is permanent — create a snapshot first if you may need the environment again.',
    inputParams: z.object({
      sessionId: z.string().min(1).describe('ID of the sandbox to terminate.'),
    }),
    execute: async input =>
      run(async () => {
        try {
          const session = await getClient().get(input.sessionId);
          if (isTerminal(session.state)) {
            return {
              sessionId: input.sessionId,
              terminated: true,
              alreadyTerminated: true,
              state: session.state,
            };
          }
          await session.close();
          return { sessionId: input.sessionId, terminated: true, alreadyTerminated: false };
        } catch (error) {
          if (error instanceof SessionNotFoundError || error instanceof SessionTerminatedError) {
            return {
              sessionId: input.sessionId,
              terminated: true,
              alreadyTerminated: true,
              note: 'Sandbox no longer exists — nothing to terminate.',
            };
          }
          throw error;
        }
      }),
  });

  return experimental_createToolkit('TENKI', {
    name: 'Tenki Sandboxes',
    description:
      'Disposable Linux microVMs from Tenki (tenki.cloud) that boot in ~2-4 seconds. ' +
      'Use these tools whenever you need an isolated Linux environment to run shell commands or code safely: ' +
      'create a sandbox, execute commands in it, snapshot its state, and terminate it when done.',
    ...(options.preload !== undefined ? { preload: options.preload } : {}),
    tools: [
      createSandbox,
      execCommand,
      listSandboxes,
      getSandbox,
      createSnapshot,
      terminateSandbox,
    ],
  });
}
