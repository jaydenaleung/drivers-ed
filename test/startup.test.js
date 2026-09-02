import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');

/**
 * A bad .env must fail FAST and VISIBLY. Exit 1 makes systemd restart every 5
 * seconds forever on a fault no restart can fix, burying the reason in the
 * journal. Exit 78 (EX_CONFIG) pairs with RestartPreventExitStatus=78 in the
 * unit file so the service stops with the reason on screen.
 */
function runBot(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ENTRY],
      {
        // A blank value must override the real .env, not fall through to it.
        env: { ...process.env, ...env },
        timeout: 15000,
        cwd: ROOT,
      },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });
}

const BASE = {
  DASHBOARD_PASSWORD: 'x',
  SESSION_SECRET: 'c'.repeat(64),
  POST_SOURCE: 'x',
  X_BEARER_TOKEN: 'token',
  X_ACCOUNT_USER_ID: '123',
  GMAIL_ADDRESS: 'a@b.c',
  GMAIL_APP_PASSWORD: 'p',
  NTFY_TOPIC: 'topic',
  DRY_RUN: 'true',
};

test('a config error exits 78, not 1, so systemd does not restart-loop', async () => {
  const { code, stderr } = await runBot({ ...BASE, DRY_RUN: 'false', NTFY_TOPIC: '' });

  assert.equal(code, 78, 'exit 1 here would restart-loop every 5 seconds forever');
  assert.match(stderr, /NTFY_TOPIC is not set \(required when DRY_RUN=false\)/);
});

test('the failure names which config file was actually read', async () => {
  const { stderr } = await runBot({ ...BASE, DASHBOARD_PASSWORD: '' });

  assert.match(stderr, /Config was read from:/, 'editing the wrong .env is the usual cause');
  assert.match(stderr, /systemctl restart drivers-ed/, 'tell them how to apply the fix');
});

test('a missing session secret is caught before the server ever binds', async () => {
  const { code, stderr } = await runBot({ ...BASE, SESSION_SECRET: '' });
  assert.equal(code, 78);
  assert.match(stderr, /SESSION_SECRET/);
});
