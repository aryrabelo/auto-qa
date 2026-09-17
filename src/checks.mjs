import { assertReadable, visibleNodes } from './actions.mjs';

export function validateChecks(checks) {
  if (!Array.isArray(checks)) throw new Error('checks must be an array.');
  for (const check of checks) {
    if (!check || typeof check.name !== 'string' || !check.name.trim()) throw new Error('Every check needs a name.');
    if (typeof check.textIncludes === 'string' && check.textIncludes.length > 0 && !check.selector && !check.expected) continue;
    const keys = ['identifier', 'label', 'role'];
    const expectedKeys = ['label', 'value', 'selected', 'enabled'];
    if (!check.selector || !Object.keys(check.selector).length || !check.expected || !Object.keys(check.expected).length ||
      !Object.entries(check.selector).every(([k, v]) => keys.includes(k) && typeof v === 'string') ||
      !Object.entries(check.expected).every(([k, v]) => expectedKeys.includes(k) &&
        (['selected', 'enabled'].includes(k) ? typeof v === 'boolean' : typeof v === 'string')) || check.textIncludes != null) {
      throw new Error(`Invalid check: ${check.name}. Use textIncludes OR selector + expected.`);
    }
  }
}

export function evaluateChecks(snapshot, checks) {
  assertReadable(snapshot);
  const nodes = visibleNodes(snapshot);
  return checks.map(check => {
    if (check.textIncludes != null) {
      const matches = nodes.filter(n => [n.label, n.value].some(v => typeof v === 'string' && v.includes(check.textIncludes)));
      return { name: check.name, status: matches.length ? 'passed' : 'failed', expected: check.textIncludes,
        observed: matches.map(n => ({ ref: n.ref, label: n.label, value: n.value })) };
    }
    const matches = nodes.filter(n => Object.entries(check.selector).every(([key, value]) => n[key] === value));
    const passed = matches.length === 1 && Object.entries(check.expected).every(([key, value]) => matches[0][key] === value);
    return { name: check.name, status: passed ? 'passed' : 'failed', selector: check.selector, expected: check.expected,
      observed: matches.map(n => Object.fromEntries(['ref', ...Object.keys(check.expected)].map(key => [key, n[key] ?? null]))),
      ...(matches.length !== 1 ? { reason: `Expected one visible matching node, found ${matches.length}.` } : {}) };
  });
}

