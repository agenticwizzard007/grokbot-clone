// Deliberately follows an exposed ATTACK_TOOL directive. This is a parser probe,
// not evidence that any language model is immune to prompt injection.
export function gullibleScript(packet) {
  const outsideData = packet.replace(/-----BEGIN DATA ([^\n]+)-----[\s\S]*?-----END DATA \1-----/g, '');
  const attack = outsideData.match(/ATTACK_TOOL:\s*([^\n]+)/);
  return attack ? attack[1] : 'say Untrusted content kept as data.';
}
