// Settings for Create-tab tools, shared by the browser and the server so both compute the same cache key.
// A key names one stored result: the same recording + tool + key is generated once and then reused.
// Default settings have the empty key, so results saved before settings existed keep matching.
// Pure functions only.

export const TOOL_SETTINGS = {
  flashcards: {
    size: { label: 'How many', def: 'standard', options: { fewer: 'Fewer', standard: 'Recommended', more: 'More' } },
  },
  quiz: {
    size: { label: 'Questions', def: 'standard', options: { fewer: 'Fewer', standard: 'Recommended', more: 'More' } },
    difficulty: { label: 'Difficulty', def: 'standard', options: { standard: 'Standard', harder: 'Challenging' } },
    types: { label: 'Question types', def: 'mixed', options: { mixed: 'Mixed', multiple_choice: 'Multiple choice', true_false: 'True / false' } },
  },
  study_guide: {
    focus: { label: 'Focus', def: 'balanced', options: { balanced: 'Balanced', exam: 'Exam focused', concepts: 'Key concepts', detailed: 'Detailed' } },
  },
  reply_draft: {
    intent: { label: 'What should the reply do?', def: 'acknowledge', options: { acknowledge: 'Acknowledge', confirm: 'Confirm', question: 'Ask a question', follow_up: 'Follow up', decline: 'Decline', custom: 'Custom' } },
  },
  followup_email: {
    goal: { label: 'What should this email accomplish?', def: 'recap', options: { recap: 'Recap & next steps', confirm: 'Confirm decisions', request: 'Ask for updates', custom: 'Custom' } },
  },
};
// tools that also take free-text instructions from the user
export const TAKES_INSTRUCTIONS = new Set(['reply_draft', 'followup_email']);
export const MAX_INSTRUCTIONS = 500;

const KEY_NAME = { size: 'size', difficulty: 'diff', types: 'types', focus: 'focus', intent: 'intent', goal: 'goal' };

// FNV-1a, 32 bit: a short stable fingerprint of the user's instructions for the cache key
function fingerprint(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// -> { settings, key }: unknown values fall back to defaults; defaults are left out of the key
export function normalizeToolSettings(kind, raw = {}) {
  const spec = TOOL_SETTINGS[kind] || {};
  const settings = {};
  const parts = [];
  for (const [name, s] of Object.entries(spec)) {
    const v = Object.hasOwn(s.options, raw?.[name]) ? raw[name] : s.def;
    settings[name] = v;
    if (v !== s.def) parts.push(`${KEY_NAME[name]}=${v}`);
  }
  if (TAKES_INSTRUCTIONS.has(kind)) {
    const text = String(raw?.instructions || '').replace(/\s+/g, ' ').trim().slice(0, MAX_INSTRUCTIONS);
    settings.instructions = text;
    if (text) parts.push(`i=${fingerprint(text)}`);
  }
  return { settings, key: parts.join(';') };
}

// "10 questions · Challenging · Multiple choice" style label of the non-default choices
export function describeSettings(kind, settings = {}) {
  const spec = TOOL_SETTINGS[kind] || {};
  const out = Object.entries(spec).filter(([n, s]) => settings[n] && settings[n] !== s.def).map(([n, s]) => s.options[settings[n]]);
  if (settings.instructions) out.push('with your instructions');
  return out.join(' · ');
}
