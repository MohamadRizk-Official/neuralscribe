// Cost and usage accounting for every AI request.
//
// One JSON line per Anthropic request (and one per result served from storage) is written to the server
// log as "[ai-usage] {…}": feature, model, tokens (uncached / cache write / cache read / output), latency,
// estimated cost, transcription and user id, whether the output passed grounding, and whether it was cached.
// Locally, AI_USAGE_LOG=<file> also appends the lines to a file (never on Vercel).
// Never logged: prompts, transcript text, answers, API keys.
import { appendFileSync } from 'node:fs';

// USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10). Haiku 5.5 is priced by
// prompt length: prompts over 100k tokens pay the "long" rates.
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, cacheWrite: 0.125, cacheRead: 0.01, out: 0.50, long: { above: 100_000, in: 0.50, cacheWrite: 0.625, cacheRead: 0.05, out: 2.50 } },
  'claude-sonnet-5-5': { in: 2, cacheWrite: 2.5, cacheRead: 0.10, out: 10 },
  'claude-opus-5-5': { in: 4, cacheWrite: 5, cacheRead: 0.20, out: 20 },
};

export function estimateCost(model, u) {
  const base = PRICES[model] || PRICES[Object.keys(PRICES).find((k) => model?.startsWith(k))];
  if (!base) return null;
  const prompt = (u.uncached || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0);
  const p = base.long && prompt > base.long.above ? base.long : base;
  const usd = ((u.uncached || 0) * p.in + (u.cacheWrite || 0) * p.cacheWrite + (u.cacheRead || 0) * p.cacheRead + (u.output || 0) * p.out) / 1e6;
  return Math.round(usd * 1e7) / 1e7;
}

function emit(entry) {
  const line = JSON.stringify(entry);
  console.log(`[ai-usage] ${line}`);
  const file = process.env.AI_USAGE_LOG;
  if (file && !process.env.VERCEL) {
    try { appendFileSync(file, line + '\n'); } catch { /* logging must never break a request */ }
  }
}

// One meter per user action (e.g. "generate the meeting insights"). Every model call made for it is
// recorded; finish() writes them once grounding has been checked.
export function createMeter({ feature, transcriptionId, userId }) {
  const calls = [];
  return {
    // wraps one provider call: measures latency, records usage
    async call(task, fn) {
      const t0 = Date.now();
      let r;
      try {
        r = await fn();
      } catch (err) {
        // a rejected request is still logged (normally 0 tokens: the API refuses before generating)
        calls.push({ task, model: null, latencyMs: Date.now() - t0, inputTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, failed: true });
        throw err;
      }
      const u = r.usage || {};
      calls.push({
        task, model: r.model, latencyMs: Date.now() - t0,
        inputTokens: u.input || 0, uncachedInputTokens: u.uncached ?? u.input ?? 0,
        cacheWriteTokens: u.cacheWrite || 0, cacheReadTokens: u.cacheRead || 0, outputTokens: u.output || 0,
      });
      return r;
    },
    finish({ groundingPassed = null, droppedItems = 0, cached = false, error = null } = {}) {
      const base = { ts: new Date().toISOString(), feature, transcriptionId, userId };
      if (cached && !calls.length) {
        emit({ ...base, task: feature, model: null, cached: true, inputTokens: 0, outputTokens: 0, latencyMs: 0, estimatedCostUsd: 0, actualCostUsd: null, groundingPassed: null });
        return;
      }
      for (const c of calls) {
        emit({
          ...base, ...c, cached: false,
          estimatedCostUsd: c.failed ? 0 : estimateCost(c.model, { uncached: c.uncachedInputTokens, cacheWrite: c.cacheWriteTokens, cacheRead: c.cacheReadTokens, output: c.outputTokens }),
          actualCostUsd: null, // the API reports tokens, not money; the Anthropic Console shows billed totals
          groundingPassed, droppedItems, ...(error && { error }),
        });
      }
    },
  };
}
