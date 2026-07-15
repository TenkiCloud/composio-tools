/**
 * Live smoke test for @tenkicloud/composio-tools.
 *
 * Binds the Tenki toolkit to a REAL Composio session, then drives every
 * LOCAL_TENKI_* tool programmatically via session.execute() in sequence:
 *
 *   CREATE_SANDBOX → GET_SANDBOX → LIST_SANDBOXES → EXEC_COMMAND (uname -a)
 *   → CREATE_SNAPSHOT → TERMINATE_SANDBOX → TERMINATE_SANDBOX (idempotency)
 *
 * Requires real keys — run it from a machine with network access:
 *   COMPOSIO_API_KEY  (https://app.composio.dev)
 *   TENKI_API_KEY     (https://app.tenki.cloud)
 *
 * Usage:
 *   cp /path/to/your/.env .   # or export the two vars
 *   pnpm smoke
 */
import { Composio } from '@composio/core';
import { TenkiSandbox } from '@tenkicloud/sandbox';
import 'dotenv/config';
import { tenkiToolkit } from '../src/index';

const line = (title: string) =>
  console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`);

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

const results: StepResult[] = [];

function record(step: string, ok: boolean, detail?: string): void {
  results.push({ step, ok, detail });
  console.log(ok ? `✅ ${step}` : `❌ ${step}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Execute one tool through the Composio session and assert success.
 * A step passes when Composio reports no error AND the tool's own
 * structured result has success: true.
 */
async function runTool(
  session: {
    execute: (
      slug: string,
      args?: Record<string, unknown>
    ) => Promise<{ data: Record<string, unknown>; error: string | null; logId: string }>;
  },
  step: string,
  slug: string,
  args: Record<string, unknown>,
  expectSuccess = true
): Promise<Record<string, unknown>> {
  line(step);
  console.log(`→ ${slug}`, JSON.stringify(args));
  const response = await session.execute(slug, args);
  console.log(`← logId=${response.logId} error=${JSON.stringify(response.error)}`);
  console.log(JSON.stringify(response.data, null, 2));

  const toolSucceeded = response.error === null && response.data?.success === true;
  record(step, toolSucceeded === expectSuccess, response.error ?? undefined);
  return response.data;
}

async function main(): Promise<void> {
  for (const name of ['COMPOSIO_API_KEY', 'TENKI_API_KEY']) {
    if (!process.env[name]) {
      console.error(`❌ Missing ${name}. Copy the .env with your test keys next to package.json.`);
      process.exit(1);
    }
  }

  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

  line('Session setup');
  const session = await composio.sessions.create('default', {
    experimental: { customToolkits: [tenkiToolkit()] },
  });
  console.log(`✅ Composio session: ${session.sessionId}`);

  let sandboxId: string | undefined;
  let snapshotId: string | undefined;

  try {
    // 1. CREATE_SANDBOX
    const created = await runTool(session, '1. CREATE_SANDBOX', 'LOCAL_TENKI_CREATE_SANDBOX', {
      name: 'composio-tools-smoke',
    });
    sandboxId = created.sessionId as string | undefined;
    if (!sandboxId) throw new Error('CREATE_SANDBOX returned no sessionId — aborting');

    // 2. GET_SANDBOX
    await runTool(session, '2. GET_SANDBOX', 'LOCAL_TENKI_GET_SANDBOX', { sessionId: sandboxId });

    // 3. LIST_SANDBOXES (must contain ours)
    const listed = await runTool(session, '3. LIST_SANDBOXES', 'LOCAL_TENKI_LIST_SANDBOXES', {});
    const sandboxes = (listed.sandboxes ?? []) as Array<{ sessionId?: string }>;
    record(
      '3b. LIST contains the new sandbox',
      sandboxes.some(s => s.sessionId === sandboxId)
    );

    // 4. EXEC_COMMAND
    const exec = await runTool(session, '4. EXEC_COMMAND (uname -a)', 'LOCAL_TENKI_EXEC_COMMAND', {
      sessionId: sandboxId,
      command: 'uname -a && whoami && cat /etc/os-release | head -2',
    });
    record('4b. exec exitCode === 0', exec.exitCode === 0, `exitCode=${exec.exitCode}`);

    // 5. CREATE_SNAPSHOT
    const snap = await runTool(session, '5. CREATE_SNAPSHOT', 'LOCAL_TENKI_CREATE_SNAPSHOT', {
      sessionId: sandboxId,
      name: 'smoke-checkpoint',
    });
    record('5b. snapshot READY', snap.state === 'READY', `state=${snap.state}`);
    snapshotId = snap.snapshotId as string | undefined;

    // 6. TERMINATE_SANDBOX
    await runTool(session, '6. TERMINATE_SANDBOX', 'LOCAL_TENKI_TERMINATE_SANDBOX', {
      sessionId: sandboxId,
    });

    // 7. TERMINATE again — idempotency
    const again = await runTool(
      session,
      '7. TERMINATE_SANDBOX (idempotent re-run)',
      'LOCAL_TENKI_TERMINATE_SANDBOX',
      { sessionId: sandboxId }
    );
    record('7b. alreadyTerminated flag set', again.alreadyTerminated === true);

    sandboxId = undefined; // cleaned up
  } finally {
    // Safety net: never leave a paid microVM running if a step blew up.
    if (sandboxId) {
      line('Cleanup (safety net)');
      try {
        await session.execute('LOCAL_TENKI_TERMINATE_SANDBOX', { sessionId: sandboxId });
        console.log(`🧹 Terminated leftover sandbox ${sandboxId}`);
      } catch (error) {
        console.error(`⚠️  Could not terminate ${sandboxId} — do it manually:`, error);
      }
    }
    // Snapshots cost storage (~5GB each) — delete the test checkpoint via the SDK.
    // (Snapshot deletion is intentionally not an MVP tool, so we go direct.)
    if (snapshotId) {
      line('Cleanup snapshot');
      try {
        const tenki = new TenkiSandbox();
        await tenki.deleteSnapshot(snapshotId);
        record('8. delete smoke snapshot', true);
      } catch (error) {
        record(
          '8. delete smoke snapshot',
          false,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  line('Summary');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.step}`);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} steps failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} steps passed. 🎉`);
}

main().catch(error => {
  console.error('❌ Smoke test crashed:', error);
  process.exit(1);
});
