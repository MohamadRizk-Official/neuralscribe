// Which model does what. One place to change models or providers; nothing else calls an AI API.
//
// Defaults: Claude Haiku 5.5 for everything (fast, and about $0.10 / $0.50 per million input/output
// tokens for prompts under 100k tokens). Each task can be moved to another model with an environment
// variable, e.g. AI_MODEL_ASK=claude-sonnet-5-5, without code changes.
import { anthropicProvider, AIError } from './anthropic.js';
import { mockProvider } from './mock.js';

const DEFAULT_MODEL = 'claude-haiku-5-5';

// effort: how much the model may think. Extraction/summaries benefit from "medium"; Ask and keyword
// expansion are quick lookups → "low" for speed. max_tokens includes thinking, so it is a ceiling, not a
// target; the prompts ask for short outputs.
const TASKS = {
  overview: { env: 'AI_MODEL_SUMMARY', effort: 'medium', maxTokens: 8000 },
  detailed_summary: { env: 'AI_MODEL_SUMMARY', effort: 'medium', maxTokens: 10000 },
  notes: { env: 'AI_MODEL_SUMMARY', effort: 'medium', maxTokens: 10000 },
  insights: { env: 'AI_MODEL_INSIGHTS', effort: 'medium', maxTokens: 10000 },
  reduce: { env: 'AI_MODEL_SUMMARY', effort: 'medium', maxTokens: 10000 },
  ask: { env: 'AI_MODEL_ASK', effort: 'low', maxTokens: 3000 },
  expand: { env: 'AI_MODEL_ASK', effort: 'low', maxTokens: 600 },
};

export function taskConfig(task) {
  const base = TASKS[task.split(':')[0]] || TASKS.insights;
  return { model: process.env[base.env] || process.env.AI_MODEL || DEFAULT_MODEL, effort: base.effort, maxTokens: base.maxTokens };
}

let cached;
export function getProvider() {
  if (cached) return cached;
  const wantMock = process.env.AI_PROVIDER === 'mock';
  if (wantMock && process.env.VERCEL_ENV !== 'production') return (cached = mockProvider());
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AIError("Summaries and Ask aren't switched on for this site yet.", { status: 503, code: 'not_configured' });
  return (cached = anthropicProvider(key));
}

export { AIError };
