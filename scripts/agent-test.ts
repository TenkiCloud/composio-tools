/**
 * Agent test for @tenkicloud/composio-tools (Phase B step 3).
 *
 * A minimal agentic loop: Claude (Anthropic Messages API) is instructed to boot
 * a Tenki sandbox, inspect it with a shell command, and clean up — using ONLY
 * the LOCAL_TENKI_* tools bound to a real Composio session.
 *
 * Architecture note: custom tools are SESSION-scoped, so tool_use blocks are
 * executed via session.execute() — not provider.handleToolCalls(), which goes
 * through Composio's global execute path and cannot see session-bound custom
 * tools. Tool definitions come from session.customTools() for the same reason.
 *
 * Requires in .env (or exported):
 *   COMPOSIO_API_KEY   (https://app.composio.dev)
 *   TENKI_API_KEY      (https://app.tenki.cloud)
 *   ANTHROPIC_API_KEY  (https://console.anthropic.com/settings/keys)
 * Optional:
 *   ANTHROPIC_MODEL    (default: claude-sonnet-5)
 *
 * Usage: pnpm agent
 */
import Anthropic from '@anthropic-ai/sdk';
import { Composio } from '@composio/core';
import 'dotenv/config';
import { tenkiToolkit } from '../src/index';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const MAX_TURNS = 10;

const TASK = [
  'Boot a fresh Tenki sandbox, then find out which Linux kernel version and OS distribution',
  'it runs by executing a shell command inside it. When you have the answer, terminate the',
  'sandbox to free resources, then report: (1) kernel version, (2) distribution, and',
  '(3) confirmation that the sandbox was terminated.',
].join(' ');

const line = (title: string) =>
  console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`);

async function main(): Promise<void> {
  for (const name of ['COMPOSIO_API_KEY', 'TENKI_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (!process.env[name]) {
      console.error(`❌ Missing ${name} — add it to .env`);
      process.exit(1);
    }
  }

  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  const anthropic = new Anthropic();

  line('Session setup');
  const session = await composio.sessions.create('default', {
    experimental: { customToolkits: [tenkiToolkit()] },
  });
  console.log(`✅ Composio session: ${session.sessionId}`);

  // Build Claude tool definitions straight from the session's custom-tool registry.
  const tools: Anthropic.Tool[] = session.customTools({ toolkit: 'TENKI' }).map(tool => ({
    name: tool.slug,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
  console.log(`✅ Tools exposed to the agent: ${tools.map(t => t.name).join(', ')}`);

  // Verification trackers
  const liveSandboxes = new Set<string>();
  let sawCreate = false;
  let sawSuccessfulExec = false;
  let sawTerminate = false;
  let finalText = '';

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: TASK }];

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      line(`Turn ${turn} → ${MODEL}`);
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system:
          'You are an infrastructure agent. Use only the provided tools to complete the task. ' +
          'Always terminate any sandbox you created before giving your final answer.',
        tools,
        messages,
      });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`🤖 ${block.text.trim()}`);
          finalText = block.text;
        }
      }

      if (response.stop_reason !== 'tool_use') {
        console.log(`(stop_reason=${response.stop_reason})`);
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        console.log(`🔧 ${block.name} ${JSON.stringify(args)}`);

        const result = await session.execute(block.name, args);
        const data = result.data ?? {};
        console.log(`   → ${JSON.stringify(data).slice(0, 400)}`);

        // Track lifecycle for verification + cleanup safety net
        if (block.name === 'LOCAL_TENKI_CREATE_SANDBOX' && data.success === true) {
          sawCreate = true;
          if (typeof data.sessionId === 'string') liveSandboxes.add(data.sessionId);
        }
        if (block.name === 'LOCAL_TENKI_EXEC_COMMAND' && data.exitCode === 0) {
          sawSuccessfulExec = true;
        }
        if (block.name === 'LOCAL_TENKI_TERMINATE_SANDBOX' && data.terminated === true) {
          sawTerminate = true;
          if (typeof args.sessionId === 'string') liveSandboxes.delete(args.sessionId);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(data),
          ...(result.error !== null ? { is_error: true } : {}),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  } finally {
    // Safety net: never leave a paid microVM running, whatever the agent did.
    for (const id of liveSandboxes) {
      line('Cleanup (safety net)');
      try {
        await session.execute('LOCAL_TENKI_TERMINATE_SANDBOX', { sessionId: id });
        console.log(`🧹 Terminated leftover sandbox ${id}`);
      } catch (error) {
        console.error(`⚠️  Could not terminate ${id} — do it manually:`, error);
      }
    }
  }

  line('Verification');
  const checks: Array<[string, boolean]> = [
    ['agent created a sandbox', sawCreate],
    ['agent ran a command successfully (exitCode 0)', sawSuccessfulExec],
    ['agent terminated the sandbox itself', sawTerminate],
    ['no sandboxes leaked', liveSandboxes.size === 0],
    ['agent produced a final answer', finalText.trim().length > 0],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${label}`);

  if (checks.every(([, ok]) => ok)) {
    console.log('\nAgent test passed. 🎉');
  } else {
    console.error('\nAgent test failed.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('❌ Agent test crashed:', error);
  process.exit(1);
});
