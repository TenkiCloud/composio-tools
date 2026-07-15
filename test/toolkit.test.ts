import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomTool, CustomToolkit, SessionContext } from '@composio/core';
import {
  TenkiSandbox,
  SessionNotFoundError,
  type ExecResult,
  type Identity,
  type Session,
  type Snapshot,
} from '@tenkicloud/sandbox';
import { tenkiToolkit } from '../src/toolkit';

// Mock only the TenkiSandbox client class; keep helpers (stdoutText, isTerminal, ...)
// and error classes real so tests exercise the same code paths as production.
vi.mock('@tenkicloud/sandbox', async importOriginal => {
  const actual = await importOriginal<typeof import('@tenkicloud/sandbox')>();
  return { ...actual, TenkiSandbox: vi.fn() };
});

const encoder = new TextEncoder();

const identity: Identity = {
  ownerType: 'WORKSPACE',
  ownerId: 'ws-1',
  workspaces: [
    {
      id: 'ws-1',
      name: 'My Workspace',
      projects: [{ id: 'proj-1', name: 'My Project' }],
    },
  ],
};

function fakeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    sessionId: 'sess-1',
    command: 'bash',
    args: ['-lc', 'echo hi'],
    status: 'SUCCEEDED',
    exitCode: 0,
    durationMs: 42,
    outputs: [],
    stdout: encoder.encode('hi\n'),
    stderr: new Uint8Array(),
    ...overrides,
  } as ExecResult;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test-sandbox',
    state: 'RUNNING',
    cpuCores: 2,
    memoryMb: 4096,
    diskSizeGb: 10,
    projectId: 'proj-1',
    outboundEnabled: false,
    timeoutAt: new Date('2026-07-14T12:00:00Z'),
    idleTimeoutMinutes: 30,
    tags: [],
    exec: vi.fn().mockResolvedValue(fakeExecResult()),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Session;
}

function fakeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    name: 'checkpoint',
    state: 'READY',
    sizeBytes: 123_456,
    createdAt: new Date('2026-07-14T12:00:00Z'),
    tags: [],
    ...overrides,
  } as Snapshot;
}

interface MockClient {
  whoAmI: ReturnType<typeof vi.fn>;
  createAndWait: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  createSnapshotAndWait: ReturnType<typeof vi.fn>;
}

function mockClient(overrides: Partial<MockClient> = {}): MockClient {
  const client: MockClient = {
    whoAmI: vi.fn().mockResolvedValue(identity),
    createAndWait: vi.fn().mockResolvedValue(fakeSession()),
    get: vi.fn().mockResolvedValue(fakeSession()),
    list: vi.fn().mockResolvedValue([fakeSession()]),
    createSnapshotAndWait: vi.fn().mockResolvedValue(fakeSnapshot()),
    ...overrides,
  };
  vi.mocked(TenkiSandbox).mockImplementation(() => client as unknown as TenkiSandbox);
  return client;
}

function getTool(toolkit: CustomToolkit, slug: string): CustomTool {
  const tool = toolkit.tools.find(t => t.slug === slug);
  if (!tool) throw new Error(`Tool ${slug} not found in toolkit`);
  return tool;
}

const ctx = {} as SessionContext;

async function execute(
  toolkit: CustomToolkit,
  slug: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return getTool(toolkit, slug).execute(input, ctx);
}

beforeEach(() => {
  vi.mocked(TenkiSandbox).mockReset();
  delete process.env.TENKI_WORKSPACE_ID;
  delete process.env.TENKI_PROJECT_ID;
});

describe('tenkiToolkit shape', () => {
  it('declares the TENKI toolkit with the six MVP tools', () => {
    const toolkit = tenkiToolkit();
    expect(toolkit.slug).toBe('TENKI');
    expect(toolkit.tools.map(t => t.slug).sort()).toEqual([
      'CREATE_SANDBOX',
      'CREATE_SNAPSHOT',
      'EXEC_COMMAND',
      'GET_SANDBOX',
      'LIST_SANDBOXES',
      'TERMINATE_SANDBOX',
    ]);
  });

  it('does not create a Tenki client until a tool is executed', () => {
    mockClient();
    tenkiToolkit();
    expect(TenkiSandbox).not.toHaveBeenCalled();
  });

  it('passes preload through to the toolkit', () => {
    expect(tenkiToolkit({ preload: true }).preload).toBe(true);
    expect(tenkiToolkit().preload).toBeUndefined();
  });
});

describe('CREATE_SANDBOX', () => {
  it('resolves workspace/project via whoAmI and creates the session', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit();

    const result = await execute(toolkit, 'CREATE_SANDBOX', { name: 'box' });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('sess-1');
    expect(result.state).toBe('RUNNING');
    expect(client.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', projectId: 'proj-1', name: 'box' })
    );
  });

  it('caches the whoAmI resolution across calls', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit();

    await execute(toolkit, 'CREATE_SANDBOX', {});
    await execute(toolkit, 'CREATE_SANDBOX', {});

    expect(client.whoAmI).toHaveBeenCalledTimes(1);
  });

  it('skips whoAmI when workspaceId and projectId are both provided', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit({ workspaceId: 'ws-x', projectId: 'proj-x' });

    await execute(toolkit, 'CREATE_SANDBOX', {});

    expect(client.whoAmI).not.toHaveBeenCalled();
    expect(client.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-x', projectId: 'proj-x' })
    );
  });

  it('honors TENKI_WORKSPACE_ID / TENKI_PROJECT_ID env overrides', async () => {
    const client = mockClient();
    process.env.TENKI_WORKSPACE_ID = 'ws-env';
    process.env.TENKI_PROJECT_ID = 'proj-env';

    await execute(tenkiToolkit(), 'CREATE_SANDBOX', {});

    expect(client.whoAmI).not.toHaveBeenCalled();
    expect(client.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-env', projectId: 'proj-env' })
    );
  });

  it('converts env pairs into the record expected by the Tenki SDK', async () => {
    const client = mockClient();

    await execute(tenkiToolkit(), 'CREATE_SANDBOX', {
      env: [
        { name: 'NODE_ENV', value: 'test' },
        { name: 'FOO', value: 'bar' },
      ],
    });

    expect(client.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ env: { NODE_ENV: 'test', FOO: 'bar' } })
    );
  });

  it('applies factory defaults but lets tool input win', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit({ defaults: { cpuCores: 4, allowOutbound: true } });

    await execute(toolkit, 'CREATE_SANDBOX', { cpuCores: 8 });

    expect(client.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ cpuCores: 8, allowOutbound: true })
    );
  });

  it('returns a structured error when no workspace/project is visible', async () => {
    mockClient({
      whoAmI: vi.fn().mockResolvedValue({ ownerType: 'USER', ownerId: 'u1', workspaces: [] }),
    });

    const result = await execute(tenkiToolkit(), 'CREATE_SANDBOX', {});

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'Error' });
    expect((result.error as { message: string }).message).toContain('TENKI_WORKSPACE_ID');
  });
});

describe('EXEC_COMMAND', () => {
  it('runs the command via bash -lc and maps the result', async () => {
    const session = fakeSession();
    const client = mockClient({ get: vi.fn().mockResolvedValue(session) });
    const toolkit = tenkiToolkit();

    const result = await execute(toolkit, 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'echo hi',
    });

    expect(client.get).toHaveBeenCalledWith('sess-1');
    expect(session.exec).toHaveBeenCalledWith('bash', {
      args: ['-lc', 'echo hi'],
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      status: 'SUCCEEDED',
      stdout: 'hi',
      stdoutTruncated: false,
      stderr: '',
      stderrTruncated: false,
    });
  });

  it('converts timeoutSeconds to milliseconds', async () => {
    const session = fakeSession();
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'sleep 5',
      timeoutSeconds: 120,
    });

    expect(session.exec).toHaveBeenCalledWith('bash', {
      args: ['-lc', 'sleep 5'],
      timeoutMs: 120_000,
    });
  });

  it('truncates oversized stdout and flags it', async () => {
    const big = 'x'.repeat(20_000);
    const session = fakeSession({
      exec: vi.fn().mockResolvedValue(fakeExecResult({ stdout: encoder.encode(big) })),
    } as Partial<Session>);
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'cat big-file',
    });

    expect(result.stdoutTruncated).toBe(true);
    expect((result.stdout as string).length).toBeLessThan(13_000);
    expect(result.stdout as string).toContain('[truncated');
  });

  it('returns a structured error for an unknown session instead of throwing', async () => {
    mockClient({
      get: vi.fn().mockRejectedValue(new SessionNotFoundError('session sess-x not found')),
    });

    const result = await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-x',
      command: 'echo hi',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'SessionNotFoundError' });
  });
});

describe('LIST_SANDBOXES', () => {
  it('returns summaries with a count', async () => {
    mockClient({
      list: vi
        .fn()
        .mockResolvedValue([fakeSession(), fakeSession({ id: 'sess-2', state: 'PAUSED' })]),
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.sandboxes).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', state: 'RUNNING' }),
      expect.objectContaining({ sessionId: 'sess-2', state: 'PAUSED' }),
    ]);
  });

  it('filters by state when requested', async () => {
    mockClient({
      list: vi
        .fn()
        .mockResolvedValue([fakeSession(), fakeSession({ id: 'sess-2', state: 'PAUSED' })]),
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', { state: 'PAUSED' });

    expect(result.count).toBe(1);
    expect(result.sandboxes).toEqual([expect.objectContaining({ sessionId: 'sess-2' })]);
  });

  it('never emits object schemas without properties (Composio rejects them)', () => {
    // Regression guard for ToolRouterV2_BadRequest 4300: Composio's backend rejects
    // any JSON-schema object (top-level or nested, e.g. z.record) that has no fixed
    // `properties`. Walk every tool's full input_schema tree.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const schema = node as Record<string, unknown>;
      if (schema.type === 'object') {
        const properties = schema.properties as Record<string, unknown> | undefined;
        if (!properties || Object.keys(properties).length === 0) offenders.push(path);
      }
      for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`);
    };
    for (const tool of tenkiToolkit().tools) walk(tool.inputSchema, tool.slug);
    expect(offenders).toEqual([]);
  });
});

describe('GET_SANDBOX', () => {
  it('returns full session details', async () => {
    mockClient();

    const result = await execute(tenkiToolkit(), 'GET_SANDBOX', { sessionId: 'sess-1' });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'sess-1',
      state: 'RUNNING',
      cpuCores: 2,
      memoryMb: 4096,
      projectId: 'proj-1',
      outboundNetworking: false,
      expiresAt: '2026-07-14T12:00:00.000Z',
    });
  });
});

describe('CREATE_SNAPSHOT', () => {
  it('creates a snapshot and waits for readiness', async () => {
    const client = mockClient();

    const result = await execute(tenkiToolkit(), 'CREATE_SNAPSHOT', {
      sessionId: 'sess-1',
      name: 'checkpoint',
    });

    expect(client.createSnapshotAndWait).toHaveBeenCalledWith('sess-1', { name: 'checkpoint' });
    expect(result).toMatchObject({
      success: true,
      snapshotId: 'snap-1',
      state: 'READY',
      createdAt: '2026-07-14T12:00:00.000Z',
    });
  });
});

describe('TERMINATE_SANDBOX', () => {
  it('closes a running sandbox', async () => {
    const session = fakeSession();
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(session.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, terminated: true, alreadyTerminated: false });
  });

  it('is idempotent for an already-terminated sandbox', async () => {
    const session = fakeSession({ state: 'TERMINATED' });
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(session.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      terminated: true,
      alreadyTerminated: true,
      state: 'TERMINATED',
    });
  });

  it('is idempotent for a missing sandbox', async () => {
    mockClient({ get: vi.fn().mockRejectedValue(new SessionNotFoundError('gone')) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-x' });

    expect(result).toMatchObject({ success: true, terminated: true, alreadyTerminated: true });
  });

  it('still surfaces unrelated errors as structured results', async () => {
    mockClient({ get: vi.fn().mockRejectedValue(new Error('network down')) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'Error', message: 'network down' });
  });
});

describe('error handling', () => {
  it('never throws: a missing API key surfaces as a structured error on first call', async () => {
    vi.mocked(TenkiSandbox).mockImplementation(() => {
      throw new Error('TENKI_API_KEY is not set');
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('TENKI_API_KEY');
  });
});
