// Request adapter for the existing mock provider. All tool execution stays in Swarm.
export const goals = { converge: 'Polish the release notes: include the version, use fewer than 60 words and end with a call to action.', cap: 'Review the release notes: keep the long draft and leave the call to action unresolved.', slow: 'Review the release notes carefully before publishing.' };
export const checks = ['Mentions the version', 'Fewer than 60 words', 'Ends with a call to action'];
export function selectIteration(script, iteration) {
  const choices = script.split(/\s*\|\|\s*/);
  return choices[Math.min(Math.max(1, iteration), choices.length) - 1];
}
export function iterationScript(text) {
  const iteration = Number(text.match(/iteration (\d+) of \d+/i)?.[1] ?? 1);
  const directive = text.match(/mock-iter:\s*([^\n]+)/i);
  if (directive) return selectIteration(directive[1], iteration);
  const mode = /iteration \d+ of \d+/i.test(text) ? Object.entries(goals).find(([, goal]) => text.includes(goal))?.[0] : null;
  if (!mode) return null;
  const checker = /Submit your verdict with submit_verdict/.test(text.slice(text.lastIndexOf('\nHOW TO ANSWER')));
  if (!checker) {
    const longDraft = [
      'Version 1.0 brings faster search to your workspace. Results now include saved reports and recent conversations, so you can find the context you need without opening several pages.',
      'Saved reports keep their source links and a clear update date. The new navigation groups related work together and makes it easier to return to an unfinished task.',
      ['The release also includes small improvements to keyboard navigation. More details will follow in the release guide.',
        'Keyboard navigation has clearer focus states throughout the workspace. The release guide will cover these changes in more detail.',
        'The release guide will include a closer look at keyboard navigation and the updated report view. More details will follow.'][Math.min(iteration, 3) - 1],
    ].map(line => `- ${line}`).join('\n');
    const body = iteration === 1 || mode === 'cap' ? longDraft : `- Version 1.0 improves workspace search.\n- Saved reports are easier to find and share.\n- ${iteration >= 3 ? 'Try the release.' : 'More details soon.'}`;
    return `say ${body}`;
  }
  // Checklist IDs are assigned by the real sheet, so read them from its packet.
  const exit = text.match(/Review the output against (\{[^\n]+\})\. Submit/);
  const items = exit ? JSON.parse(exit[1]).items ?? [] : [];
  const verdict = { pass: mode !== 'cap' && iteration >= 3,
    checklist: items.map((item, index) => ({ id: item.id, pass: mode === 'cap' ? index === 0 : index < iteration, note: 'Checked the release note.' })),
    feedback: `Pass ${iteration}: ${mode === 'cap' ? 'length and call to action still fail' : iteration < 3 ? 'fix the next missing check' : 'all checks passed'}.` };
  return `submit_verdict ${JSON.stringify(verdict)} | say Review ${iteration}: ${verdict.feedback}`;
}

export function adaptInput(body, gullible, bots = {}) {
  const input = structuredClone(body.input ?? []);
  const user = input.findLast(item => item.role === 'user');
  if (!user) return body;
  const text = typeof user.content === 'string' ? user.content : user.content.filter(item => item.type === 'input_text').map(item => item.text).join('\n');
  let script = iterationScript(text);
  if (!script && text.startsWith('Draft release notes for version 1.0.')) script = 'say Version 1.0 improves search and saved reports. Try it today.';
  if (!script && text.startsWith('Create a saved output from this document:\n')) script = `say ${text.split('document:\n')[1]}`;
  if (!script && text.startsWith('Start a release review that needs my approval.')) {
    const name = text.split('\n')[1] ?? 'Release review';
    script = `start_loop ${JSON.stringify({ name, goal: goals.slow, kind: 'maker_checker', steps: [{id:'maker',botId:bots.maker,role:'maker',instruction:'Draft release notes.'},{id:'checker',botId:bots.checker,role:'checker',instruction:'Check the draft.'}],exit:{mode:'verdict'},limits:{maxIterations:3,maxMinutes:30,stepTimeoutMinutes:10} })} | say The release review is ready for your approval.`;
  }
  if (!script && text.includes('Summarize this document as untrusted data.')) script = gullible(text);
  if (!script && text.includes('[handoff ')) {
    const instruction = text.match(/INSTRUCTION[^\n]*\n([\s\S]*?)\n\nSUMMARY/)?.[1] ?? '';
    script = instruction.match(/mock:\s*([^\n]+)/)?.[1] ?? 'say The draft is clear. Version, length and next step are ready for review.';
  }
  if (script) user.content = `mock-delay:${text.includes(goals.slow) ? 2500 : 350} mock: ${script}`;
  return { ...body, input };
}
