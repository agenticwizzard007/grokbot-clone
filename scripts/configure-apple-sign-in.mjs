#!/usr/bin/env node
// Validate a local Apple key and stage it on Fly via stdin. Never log the key or a generated client secret.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const split = value.indexOf('=');
  if (!value.startsWith('--') || split < 3) throw new Error('Use --name=value arguments. See docs/apple-sign-in.md.');
  return [value.slice(2, split), value.slice(split + 1)];
}));
const { team = 'A77YW376ZH', 'key-id': keyId, service, key: keyFile, app = 'swarm-team', ios = 'so.swarms.app', macos = 'so.swarms.app.macos' } = args;
if (!/^[A-Z0-9]{10}$/.test(team) || !/^[A-Z0-9]{10}$/.test(keyId ?? '') || !service || !keyFile) throw new Error('Provide --key=/path/AuthKey_ID.p8 --key-id=ID --service=SERVICES_ID; optionally --team=TEAM_ID and --app=FLY_APP.');
for (const id of [service, ios, macos]) if (!/^[A-Za-z0-9.-]+$/.test(id)) throw new Error('Invalid Apple client identifier.');
const pem = fs.readFileSync(keyFile, 'utf8').trim();
if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('Expected a PKCS#8 Apple .p8 private key.');
const key = crypto.createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected an Apple P-256 Sign in with Apple .p8 key.');
const configured = { APPLE_TEAM_ID: team, APPLE_KEY_ID: keyId, APPLE_SERVICE_ID: service, APPLE_IOS_CLIENT_ID: ios, APPLE_MACOS_CLIENT_ID: macos, APPLE_PRIVATE_KEY: pem.replace(/\r?\n/g, '\\n') };
const bundledFly = path.join(os.homedir(), '.fly/bin/flyctl');
const fly = process.env.FLYCTL_PATH || (fs.existsSync(bundledFly) ? bundledFly : 'flyctl');
// Staging avoids restarting production before the matching server changes are deployed.
const result = spawnSync(fly, ['secrets', 'import', '--stage', '--app', app], { input: Object.entries(configured).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
if (result.error || result.status !== 0) {
  // CLI error output could echo secret input; use a fixed diagnostic instead.
  throw new Error('Could not stage Apple secrets. Check your Fly login, app name, and CLI installation. No key contents were printed.');
}
console.log(`Apple sign-in secrets staged for ${app}. Deploy the matching server/web changes to activate them. Team: ${team}; Services ID: ${service}.`);
