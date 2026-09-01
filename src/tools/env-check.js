/**
 * Shows which configuration values are loaded, WITHOUT printing any secret.
 *
 *   npm run env-check
 *
 * Use this after copying your .env onto the server to confirm the transfer
 * didn't truncate or mangle anything. It prints key names, value lengths, and
 * a handful of non-secret settings — never the values themselves, so it is
 * safe to run over a shared screen or paste into a chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, validateConfig, haikuEnabled } from '../config.js';

const files = ['.env.local', '.env']
  .map((f) => path.join(config.root, f))
  .filter((f) => fs.existsSync(f));

console.log('\nConfiguration check (no secret values are printed)\n');

if (files.length === 0) {
  console.log('  No .env or .env.local found in', config.root);
  process.exit(1);
}

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  console.log(`  ${path.basename(file)}  (${raw.length} bytes, ${crlf ? 'CRLF — see note below' : 'LF'})`);
}
console.log('');

/** Secrets: report presence and length only. */
const SECRETS = {
  X_BEARER_TOKEN: config.x.bearerToken,
  GMAIL_APP_PASSWORD: config.email.appPassword,
  ANTHROPIC_API_KEY: config.anthropic.apiKey,
  NTFY_TOPIC: config.ntfy.topic,
  DASHBOARD_PASSWORD: config.dashboard.password,
  SESSION_SECRET: config.dashboard.sessionSecret,
};

console.log('  Secrets:');
for (const [name, value] of Object.entries(SECRETS)) {
  const state = value ? `set (${value.length} chars)` : 'MISSING';
  console.log(`    ${name.padEnd(22)} ${state}`);
}

/** Non-secret settings: safe to show in full, and the ones most often wrong. */
console.log('\n  Settings:');
const settings = [
  ['GMAIL_ADDRESS', config.email.address],
  ['CLAIM_EMAIL_TO', config.email.to],
  ['X_ACCOUNT_USER_ID', config.x.accountUserId],
  ['ANTHROPIC_MODEL', config.anthropic.model],
  ['NTFY_SERVER', config.ntfy.server],
  ['HOST:PORT', `${config.host}:${config.port}`],
  ['DATABASE_PATH', config.databasePath],
  ['POLL_INTERVAL_SECONDS', config.pollIntervalSeconds],
  ['TIMEZONE', config.timezone],
  ['POST_SOURCE', config.postSource],
  ['DRY_RUN', config.dryRun],
];
for (const [name, value] of settings) {
  console.log(`    ${name.padEnd(22)} ${value}`);
}

console.log('\n  Derived:');
console.log(`    Haiku parser           ${haikuEnabled(config) ? 'enabled' : 'DISABLED (regex only)'}`);

// The two settings most likely to cause an unwanted real send.
const warnings = [];
if (!config.dryRun && /needhamdrivingschool\.com/i.test(config.email.to)) {
  warnings.push('DRY_RUN is off AND the claim email points at the real driving school. Live.');
}
if (config.dryRun) {
  warnings.push('DRY_RUN is on — no email or push will actually be sent.');
}
if (config.ntfy.topic && config.ntfy.topic.length < 24) {
  warnings.push(
    `NTFY_TOPIC is only ${config.ntfy.topic.length} characters. Topics are public to anyone who ` +
      'guesses them; 32+ is safer (openssl rand -hex 16).',
  );
}

if (warnings.length) {
  console.log('\n  Notes:');
  for (const w of warnings) console.log(`    - ${w}`);
}

const problems = validateConfig();
console.log('');
if (problems.length) {
  console.log('  Validation FAILED — the bot would refuse to start:');
  for (const p of problems) console.log(`    - ${p}`);
  console.log('');
  process.exit(1);
}

console.log('  Validation passed — the bot would start with this configuration.\n');
