// Request adapter for the existing mock provider. All tool execution stays in Swarm.
export const checks = ['Mentions the version', 'Fewer than 60 words', 'Ends with a call to action'];
export function selectIteration(script, iteration) {
  const choices = script.split(/\s*\|\|\s*/);
  return choices[Math.min(Math.max(1, iteration), choices.length) - 1];
}
export function iterationScript(text) {
  const iteration = Number(text.match(/iteration (\d+) of \d+/i)?.[1] ?? 1);
  const directive = text.match(/mock-iter:\s*([^\n]+)/i);
  if (directive) return selectIteration(directive[1], iteration);
  const mode = text.match(/HO-H (converge|cap|slow)/)?.[1];
  if (!mode) return null;
  const checker = /to "Checker"/.test(text);
  if (!checker) {
    const body = `- Version ${iteration}.0\n- ${iteration === 1 || mode === 'cap' ? 'Placeholder detail. '.repeat(65) : 'Placeholder release improvement.'}\n- ${iteration >= 3 && mode !== 'cap' ? 'Try the release.' : 'More details soon.'}`;
    return `say ${body}`;
  }
  // Checklist IDs are assigned by the real sheet, so read them from its packet.
  const exit = text.match(/Review the output against (\{[^\n]+\})\. Submit/);
  const items = exit ? JSON.parse(exit[1]).items ?? [] : [];
  const verdict = { pass: mode !== 'cap' && iteration >= 3,
    checklist: items.map((item, index) => ({ id: item.id, pass: mode === 'cap' ? index === 0 : index < iteration, note: 'Checked the placeholder release note.' })),
    feedback: `Pass ${iteration}: ${mode === 'cap' ? 'length and call to action still fail' : iteration < 3 ? 'fix the next missing check' : 'all checks passed'}.` };
  return `submit_verdict ${JSON.stringify(verdict)} | say Placeholder review pass ${iteration}.`;
}

export function adaptInput(body, gullible) {
  const input = structuredClone(body.input ?? []);
  const user = input.findLast(item => item.role === 'user');
  if (!user) return body;
  const text = typeof user.content === 'string' ? user.content : user.content.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
  let script = iterationScript(text);
  if (!script && text.includes('HO-H gullible')) script = gullible(text);
  if (!script && text.startsWith('[handoff') && !text.includes('mock:')) script = 'say Placeholder handoff reviewed.';
  if (script) user.content = `mock-delay:${text.includes('HO-H slow') ? 2500 : 350} mock: ${script}`;
  return { ...body, input };
}
