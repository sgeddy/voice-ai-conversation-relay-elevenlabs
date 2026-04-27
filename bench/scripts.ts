/**
 * Conversation scripts the bench plays into a real call against the agent.
 *
 * Each step injects an utterance via Twilio TTS (`<Say>`), then waits for the
 * agent to respond before the next utterance. `waitAfterMs` should be longer
 * than the agent's expected response time for the previous utterance.
 *
 * Utterances should be plain ASCII to avoid TwiML XML-escaping issues; if you
 * add quotes or special chars, escape them in the runner.
 */
export interface BenchStep {
  utterance: string;
  /** ms to wait after dispatching this utterance, before sending the next one. */
  waitAfterMs: number;
}

export interface BenchScript {
  name: string;
  description: string;
  /** ms to wait after the call connects before the first utterance — gives the agent time to play its welcome greeting. */
  preRollMs: number;
  steps: BenchStep[];
}

export const BASELINE_SCRIPT: BenchScript = {
  name: 'baseline',
  description:
    'Four-turn conversation about voice AI. Mix of short and longer prompts to exercise variable response lengths.',
  preRollMs: 4000,
  steps: [
    { utterance: 'Hi, what can you help me with today?', waitAfterMs: 6000 },
    {
      utterance: 'Tell me how voice AI is being used in customer support.',
      waitAfterMs: 9000,
    },
    {
      utterance: 'What about latency? How fast does it need to be?',
      waitAfterMs: 9000,
    },
    { utterance: 'Thanks, that was helpful.', waitAfterMs: 5000 },
  ],
};

export const ALL_SCRIPTS: Record<string, BenchScript> = {
  baseline: BASELINE_SCRIPT,
};
