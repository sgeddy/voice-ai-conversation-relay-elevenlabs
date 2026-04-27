#!/usr/bin/env tsx
/**
 * Parse pino JSONL logs from a runtime capture and produce a per-turn
 * latency report.
 *
 * Capture logs (production mode emits bare JSON; dev mode wraps in
 * pino-pretty which the parser will skip):
 *
 *   NODE_ENV=production npm run dev > /tmp/voice-ai.log 2>&1 &
 *   # ... make a real call ...
 *   # Ctrl+C to stop the server
 *
 * Run report:
 *
 *   npm run analyze /tmp/voice-ai.log
 *   # or piped:
 *   cat /tmp/voice-ai.log | npm run analyze
 */
import { readFileSync } from 'node:fs';

interface LogEntry {
  level?: number;
  time?: number;
  msg?: string;
  event?: string;
  turn_id?: string;
  session_id?: string;
  ts?: number;
  latency_from_turn_start_ms?: number;
  total_latency_ms?: number;
  partial_response_length?: number;
  response_length?: number;
  reason?: string;
  text?: string;
  response?: string;
  [k: string]: unknown;
}

interface TurnSummary {
  turnId: string;
  sessionId: string | null;
  userText: string | null;
  responsePreview: string | null;
  startedAtMs: number;
  llmFirstTokenMs: number | null;
  ttsFirstTokenSentMs: number | null;
  llmStreamCompleteMs: number | null;
  totalLatencyMs: number | null;
  status: 'completed' | 'cancelled' | 'error' | 'incomplete';
  partialResponseLength: number | null;
  cancellationReason: string | null;
}

async function readInput(args: string[]): Promise<string> {
  if (args.length > 0 && args[0]) {
    return readFileSync(args[0], 'utf8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseLines(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip lines that aren't valid JSON (pino-pretty preamble, partial writes, etc.)
    }
  }
  return entries;
}

function groupByTurn(entries: LogEntry[]): Map<string, LogEntry[]> {
  const byTurn = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (!entry.turn_id || !entry.event) continue;
    const bucket = byTurn.get(entry.turn_id);
    if (bucket) bucket.push(entry);
    else byTurn.set(entry.turn_id, [entry]);
  }
  return byTurn;
}

function summarize(entries: LogEntry[]): TurnSummary[] {
  const byTurn = groupByTurn(entries);
  const summaries: TurnSummary[] = [];

  for (const [turnId, turnEntries] of byTurn) {
    const findEv = (event: string) => turnEntries.find((e) => e.event === event);

    const started = findEv('turn.started');
    const llmFirstToken = findEv('turn.llm.first_token');
    const ttsFirstSent = findEv('turn.tts.first_token_sent');
    const llmComplete = findEv('turn.llm.stream_complete');
    const completed = findEv('turn.completed');
    const cancelled = findEv('turn.cancelled');
    const error = findEv('session.error');

    let status: TurnSummary['status'] = 'incomplete';
    if (completed) status = 'completed';
    else if (cancelled) status = 'cancelled';
    else if (error) status = 'error';

    const totalEntry = completed ?? cancelled;
    const responsePreview = ((completed?.response ?? cancelled?.response) as string | undefined) ?? null;

    summaries.push({
      turnId,
      sessionId: (started?.session_id ?? null) as string | null,
      userText: (started?.text ?? null) as string | null,
      responsePreview,
      startedAtMs: (started?.ts as number | undefined) ?? 0,
      llmFirstTokenMs: (llmFirstToken?.latency_from_turn_start_ms as number | undefined) ?? null,
      ttsFirstTokenSentMs: (ttsFirstSent?.latency_from_turn_start_ms as number | undefined) ?? null,
      llmStreamCompleteMs: (llmComplete?.latency_from_turn_start_ms as number | undefined) ?? null,
      totalLatencyMs: (totalEntry?.total_latency_ms as number | undefined) ?? null,
      status,
      partialResponseLength:
        (cancelled?.partial_response_length as number | undefined) ?? null,
      cancellationReason: (cancelled?.reason as string | undefined) ?? null,
    });
  }

  return summaries.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? null;
}

function fmtMs(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value)} ms`;
}

function truncate(text: string | null, max: number): string {
  if (!text) return '—';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function report(turns: TurnSummary[]): string {
  const out: string[] = [];
  out.push('═════════════════════════════════════════════════════════════════════════');
  out.push('  Voice AI ref-arch — log analysis');
  out.push('═════════════════════════════════════════════════════════════════════════');
  out.push('');
  out.push('Per-turn report (in order):');
  out.push('');
  out.push(
    [
      'turn'.padEnd(8),
      'status'.padEnd(10),
      'llm 1st tok'.padEnd(13),
      'tts sent'.padEnd(11),
      'llm done'.padEnd(11),
      'total'.padEnd(11),
    ].join('  '),
  );
  out.push('─'.repeat(73));
  for (const turn of turns) {
    out.push(
      [
        turn.turnId.padEnd(8),
        turn.status.padEnd(10),
        fmtMs(turn.llmFirstTokenMs).padEnd(13),
        fmtMs(turn.ttsFirstTokenSentMs).padEnd(11),
        fmtMs(turn.llmStreamCompleteMs).padEnd(11),
        fmtMs(turn.totalLatencyMs).padEnd(11),
      ].join('  '),
    );
  }

  out.push('');
  out.push('Turn detail:');
  out.push('');
  for (const turn of turns) {
    out.push(`  [${turn.turnId}] ${turn.status}${turn.cancellationReason ? ` (reason: ${turn.cancellationReason})` : ''}`);
    if (turn.userText) out.push(`    user:      "${truncate(turn.userText, 80)}"`);
    if (turn.responsePreview) out.push(`    assistant: "${truncate(turn.responsePreview, 80)}"`);
    if (turn.partialResponseLength !== null) {
      out.push(`    partial response length: ${turn.partialResponseLength} chars`);
    }
    out.push('');
  }

  const completed = turns.filter((t) => t.status === 'completed');
  const cancelled = turns.filter((t) => t.status === 'cancelled');
  const errors = turns.filter((t) => t.status === 'error');
  const incomplete = turns.filter((t) => t.status === 'incomplete');

  const llmFirstTokens = completed
    .map((t) => t.llmFirstTokenMs)
    .filter((v): v is number => v !== null);
  const ttsFirstTokenSent = completed
    .map((t) => t.ttsFirstTokenSentMs)
    .filter((v): v is number => v !== null);
  const totalLatencies = completed
    .map((t) => t.totalLatencyMs)
    .filter((v): v is number => v !== null);

  out.push('═════════════════════════════════════════════════════════════════════════');
  out.push('  Aggregate (completed turns only)');
  out.push('═════════════════════════════════════════════════════════════════════════');
  out.push('');
  out.push(`  Turns total:        ${turns.length}`);
  out.push(`    completed:        ${completed.length}`);
  out.push(`    cancelled:        ${cancelled.length}`);
  out.push(`    error:            ${errors.length}`);
  out.push(`    incomplete:       ${incomplete.length}`);
  out.push('');

  if (completed.length < 20) {
    out.push(`  ⚠ Sample size n=${completed.length} is too small for stable percentiles.`);
    out.push(`    Treat p50/p95 as directional, not measured. Run M2's 50-call benchmark`);
    out.push(`    harness for statistically meaningful numbers.`);
    out.push('');
  }

  if (llmFirstTokens.length > 0) {
    out.push(`  LLM first-token latency (n=${llmFirstTokens.length}):`);
    out.push(`    p50:              ${fmtMs(percentile(llmFirstTokens, 50))}`);
    out.push(`    p95:              ${fmtMs(percentile(llmFirstTokens, 95))}`);
    out.push(`    max:              ${fmtMs(Math.max(...llmFirstTokens))}`);
    out.push('');
  }

  if (ttsFirstTokenSent.length > 0) {
    out.push(`  Time to first TTS-bound text leaving app (n=${ttsFirstTokenSent.length}):`);
    out.push(`    This is the app-measurable proxy for "first audio byte to caller".`);
    out.push(`    CR adds ~200-400 ms of opaque ElevenLabs round-trip on top.`);
    out.push(`    p50:              ${fmtMs(percentile(ttsFirstTokenSent, 50))}`);
    out.push(`    p95:              ${fmtMs(percentile(ttsFirstTokenSent, 95))}`);
    out.push(`    max:              ${fmtMs(Math.max(...ttsFirstTokenSent))}`);
    out.push('');
    out.push(`  Targets (perceived response latency): p50 < 1500 ms, p95 < 2500 ms`);
    out.push(`    See docs/latency-budget.md.`);
    const p50 = percentile(ttsFirstTokenSent, 50);
    const p95 = percentile(ttsFirstTokenSent, 95);
    if (p50 !== null) out.push(`    p50 status:       ${p50 < 1500 ? '✓ within target' : `✗ over by ${Math.round(p50 - 1500)} ms`}`);
    if (p95 !== null) out.push(`    p95 status:       ${p95 < 2500 ? '✓ within target' : `✗ over by ${Math.round(p95 - 2500)} ms`}`);
    out.push('');
  }

  if (totalLatencies.length > 0) {
    out.push(`  Total turn stream completion (n=${totalLatencies.length}, informational):`);
    out.push(`    Full Claude response stream end-to-end. Scales with response length.`);
    out.push(`    Not directly compared to budget (budget is for first-byte, not last-byte).`);
    out.push(`    p50:              ${fmtMs(percentile(totalLatencies, 50))}`);
    out.push(`    p95:              ${fmtMs(percentile(totalLatencies, 95))}`);
    out.push(`    max:              ${fmtMs(Math.max(...totalLatencies))}`);
  }

  return out.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const content = await readInput(args);
  const entries = parseLines(content);
  if (entries.length === 0) {
    console.error(
      'No JSON log lines found. Capture logs with NODE_ENV=production so pino emits raw JSON. See script header.',
    );
    process.exit(1);
  }
  const turns = summarize(entries);
  if (turns.length === 0) {
    console.error('Parsed log lines but found no turn events. Was the call answered?');
    process.exit(1);
  }
  console.log(report(turns));
}

void main();
