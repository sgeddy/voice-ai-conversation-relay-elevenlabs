#!/usr/bin/env tsx
/**
 * Synthetic-call benchmark harness.
 *
 * Uses the Twilio REST API to place real calls against the running agent,
 * scripts utterances via `<Say>` injected through `calls.update()`, and
 * writes a manifest of call SIDs that can be used to filter the agent's
 * logs for analysis with `npm run analyze`.
 *
 *   # Prereqs:
 *   #   - Agent server running with NODE_ENV=production, logs captured
 *   #   - Twilio credentials in .env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
 *   #   - TWILIO_PHONE_NUMBER set to the bench's "from" number
 *   #   - BENCH_AGENT_NUMBER set to the agent's "to" number (the number with
 *   #     the CR webhook configured)
 *
 *   npm run bench -- --calls 50 --concurrency 5
 *
 *   # Cost: ~$0.04/call. 50 calls ≈ $2.
 */
import { writeFileSync } from 'node:fs';
import twilio from 'twilio';
import { config } from '../src/config.js';
import { BASELINE_SCRIPT, type BenchScript } from './scripts.js';

interface CallResult {
  index: number;
  scriptName: string;
  callSid: string | null;
  fromNumber: string;
  toNumber: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: 'completed' | 'failed';
  error?: string;
}

interface CliArgs {
  calls: number;
  concurrency: number;
  scriptName: string;
}

function parseArgs(argv: string[]): CliArgs {
  let calls = 5;
  let concurrency = 3;
  let scriptName = 'baseline';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--calls' && argv[i + 1]) {
      calls = Number(argv[++i]);
    } else if (arg === '--concurrency' && argv[i + 1]) {
      concurrency = Number(argv[++i]);
    } else if (arg === '--script' && argv[i + 1]) {
      scriptName = argv[++i] ?? 'baseline';
    }
  }

  if (!Number.isFinite(calls) || calls < 1) {
    throw new Error('--calls must be a positive integer');
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }

  return { calls, concurrency, scriptName };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(): {
  fromNumber: string;
  toNumber: string;
  accountSid: string;
  authToken: string;
} {
  const fromNumber = config.twilio.phoneNumber;
  const toNumber = config.bench.agentNumber;
  const accountSid = config.twilio.accountSid;
  const authToken = config.twilio.authToken;

  const missing: string[] = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!fromNumber) missing.push('TWILIO_PHONE_NUMBER (the bench source number)');
  if (!toNumber) missing.push('BENCH_AGENT_NUMBER (the agent destination number)');

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for the benchmark: ${missing.join(', ')}. See .env.example.`,
    );
  }

  return { fromNumber, toNumber, accountSid, authToken };
}

async function runOneCall(
  index: number,
  client: ReturnType<typeof twilio>,
  script: BenchScript,
  fromNumber: string,
  toNumber: string,
): Promise<CallResult> {
  const startedAt = Date.now();
  let callSid: string | null = null;

  try {
    // 1. Create the call with a long-pause TwiML placeholder. Twilio dials
    //    `to` (the agent number); when answered, the agent's configured
    //    webhook returns its CR TwiML. Our bench leg holds silent.
    const call = await client.calls.create({
      from: fromNumber,
      to: toNumber,
      twiml: '<Response><Pause length="600"/></Response>',
    });
    callSid = call.sid;
    process.stdout.write(`[#${index}] ${callSid} created — `);

    // 2. Pre-roll: wait for the agent's welcome greeting to finish.
    await sleep(script.preRollMs);

    // 3. Walk the script. Each step uses calls.update() to interrupt our
    //    current TwiML and play a new <Say>. The audio plays into the call,
    //    reaching the agent's CR pipeline; the bench leg waits for the
    //    agent's reply via the trailing <Pause>.
    for (const step of script.steps) {
      await client.calls(callSid).update({
        twiml: `<Response><Say>${escapeXml(step.utterance)}</Say><Pause length="600"/></Response>`,
      });
      await sleep(step.waitAfterMs);
    }

    // 4. Hang up cleanly.
    await client.calls(callSid).update({
      twiml: '<Response><Hangup/></Response>',
    });

    const endedAt = Date.now();
    process.stdout.write(`completed in ${Math.round((endedAt - startedAt) / 1000)}s\n`);
    return {
      index,
      scriptName: script.name,
      callSid,
      fromNumber,
      toNumber,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: 'completed',
    };
  } catch (err) {
    const endedAt = Date.now();
    process.stdout.write(`FAILED: ${(err as Error).message}\n`);
    return {
      index,
      scriptName: script.name,
      callSid,
      fromNumber,
      toNumber,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status: 'failed',
      error: (err as Error).message,
    };
  }
}

async function runBatch(
  total: number,
  concurrency: number,
  script: BenchScript,
  client: ReturnType<typeof twilio>,
  fromNumber: string,
  toNumber: string,
): Promise<CallResult[]> {
  const results: CallResult[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= total) return;
      const result = await runOneCall(index, client, script, fromNumber, toNumber);
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);

  return results.sort((a, b) => a.index - b.index);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = requireEnv();
  const script = BASELINE_SCRIPT; // Only baseline for now; --script wired up for future.
  void args.scriptName;

  const client = twilio(env.accountSid, env.authToken);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = `/tmp/bench-run-${runId}.json`;

  console.log(
    `\nBenchmark run ${runId}\n  calls=${args.calls} concurrency=${args.concurrency} script=${script.name}\n  from=${env.fromNumber} to=${env.toNumber}\n  manifest=${manifestPath}\n`,
  );
  console.log('Estimated cost: $' + (args.calls * 0.04).toFixed(2) + ' (~$0.04/call)\n');

  const startedAt = Date.now();
  const results = await runBatch(
    args.calls,
    args.concurrency,
    script,
    client,
    env.fromNumber,
    env.toNumber,
  );
  const endedAt = Date.now();

  const manifest = {
    runId,
    script,
    args,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    results,
    callSids: results.filter((r) => r.callSid).map((r) => r.callSid as string),
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const completed = results.filter((r) => r.status === 'completed').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  console.log(
    `\nDone. completed=${completed} failed=${failed} duration=${Math.round((endedAt - startedAt) / 1000)}s`,
  );
  console.log(`Manifest: ${manifestPath}`);
  console.log(`\nNext: filter the agent's log file to just these call SIDs and analyze:`);
  console.log(`  jq -r '.callSids[]' ${manifestPath} | grep -F -f /dev/stdin /tmp/voice-ai.log | npm run analyze`);
}

void main().catch((err) => {
  console.error('Bench run failed:', (err as Error).message);
  process.exit(1);
});
