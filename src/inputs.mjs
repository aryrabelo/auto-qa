// Quoted literals come from the user's task, never generated text or app content.
export function promptInputs(prompt) {
  if (typeof prompt !== 'string') return {};
  const values = [...prompt.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map(match => match[1] ?? match[2]);
  return Object.fromEntries([...new Set(values)].map((value, index) => [`text${index + 1}`, value]));
}
