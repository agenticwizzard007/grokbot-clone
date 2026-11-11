import assert from 'node:assert/strict';
import ts from 'typescript';

// Parse, never eval, the real host.ts declaration. A refactor needs a reviewed
// adapter change instead of silently testing a second copy of the flags.
export function hostBasicArguments(source) {
  const tree = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'basic') matches.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1, 'Expected exactly one host basic declaration.');
  assert.ok(matches[0] && ts.isArrayLiteralExpression(matches[0]), 'Host basic flags must remain an explicit array.');
  return matches[0].elements.map(node => {
    if (ts.isStringLiteral(node)) return node.text;
    assert.ok(ts.isTemplateExpression(node) && node.head.text === '--label=swarm.tenant=' && node.templateSpans.length === 1);
    assert.equal(node.templateSpans[0].expression.getText(tree), 'tenant');
    assert.equal(node.templateSpans[0].literal.text, '');
    return '--label=swarm.tenant=usr_containment';
  });
}

export function daemonArguments(entrypoint) {
  const lines = entrypoint.split('\n').filter(line => line.startsWith('dockerd '));
  assert.equal(lines.length, 1, 'Expected exactly one dockerd invocation.');
  const match = /^dockerd ([-a-zA-Z0-9=:/., ]+) > \/run\/swarm-host\/docker.log 2>&1 &$/.exec(lines[0]);
  assert.ok(match, 'Review changes to production daemon startup before qualifying.');
  const args = match[1].split(' ');
  assert.ok(args.includes('--host=unix:///run/docker.sock'));
  assert.ok(args.includes('--data-root=/var/lib/docker'));
  return args;
}

export function desktopArguments(source) {
  const tree = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
  const matches = [];
  function visit(node) {
    if (ts.isArrayLiteralExpression(node) && node.elements.some(e => e.getText(tree) === 'release.desktopImage')) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(matches.length, 1, 'Expected one desktop launch.');
  const flags = matches[0].elements.filter(ts.isStringLiteral).map(n => n.text);
  const security = flags.filter(flag => flag.startsWith('--security-opt='));
  assert.deepEqual(security, ['--security-opt=seccomp=/opt/swarm/chromium-seccomp.json'], 'Integrate/review the desktop-only scoped profile before full qualification.');
  assert.ok(flags.includes('--tmpfs=/dev/shm:rw,nosuid,nodev,size=256m'));
  assert.ok(!flags.some(flag => /^--(?:cap-add|privileged|pid|userns|ipc|device)(?:=|$)/.test(flag)));
  return [...security, '--tmpfs=/dev/shm:rw,nosuid,nodev,size=256m'];
}

export function networkArguments(entrypoint) {
  const plans = entrypoint.split('\n').filter(line => line.startsWith('docker network inspect swarm-')).map(line => {
    const match = /\|\| docker network create ([-a-zA-Z0-9=./_ ]+) >\/dev\/null$/.exec(line);
    assert.ok(match, 'Review production bridge setup changes.');
    return match[1].split(' ');
  });
  assert.deepEqual(plans.map(args => args.at(-1)), ['swarm-app', 'swarm-desktop', 'swarm-public']);
  return plans;
}

export function assertDefaultWorkloadPolicy(source, basic) {
  assert.ok(basic.includes('--cap-drop=ALL'));
  assert.ok(!basic.some(flag => flag.startsWith('--security-opt=seccomp') || flag.startsWith('--cap-add') || flag === '--privileged'));
  const tree = ts.createSourceFile('container-policy.ts', source, ts.ScriptTarget.Latest, true);
  const strings = [];
  function visit(node) { if (ts.isStringLiteral(node)) strings.push(node.text); ts.forEachChild(node, visit); }
  visit(tree);
  assert.ok(strings.includes('--cap-drop=ALL'));
  assert.ok(!strings.some(flag => flag.includes('seccomp=') || flag.startsWith('--cap-add') || flag === '--privileged'), 'Runner/MCP must retain default seccomp and cap-drop=ALL.');
}
