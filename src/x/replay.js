import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getState, setState, STATE_KEYS } from '../db.js';

/**
 * Offline post source. Reads fixtures/replay-posts.json and feeds it through
 * the identical pipeline the live X poller uses — no API calls, no credits, no
 * public posting. This is how the whole parse -> match -> send chain gets
 * exercised end to end without touching the real driving school account.
 *
 * Set POST_SOURCE=replay in .env to use it.
 */

const DEFAULT_FIXTURE = 'fixtures/replay-posts.json';

/**
 * Mirrors fetchNewPosts(): returns only posts not already seen, oldest-first,
 * and advances the same since_id cursor. Unlike the live poller it does NOT
 * skip the first batch, because the whole point is to process the fixture.
 */
export async function fetchReplayPosts(db, { fixturePath } = {}) {
  const file = path.resolve(config.root, fixturePath ?? DEFAULT_FIXTURE);

  if (!fs.existsSync(file)) {
    throw new Error(
      `POST_SOURCE=replay but no fixture found at ${file}. ` +
        `Create it, or run with POST_SOURCE=x.`,
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Replay fixture ${file} is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(fixture)) {
    throw new Error(`Replay fixture ${file} must be a JSON array of posts`);
  }

  const cursor = getState(db, STATE_KEYS.SINCE_ID);
  const posts = fixture
    .map((p, i) => ({
      id: String(p.id ?? `replay-${i + 1}`),
      text: String(p.text ?? ''),
      created_at: p.created_at ?? null,
    }))
    .filter((p) => !cursor || Number(p.id.replace(/\D/g, '')) > Number(cursor.replace(/\D/g, '')));

  if (posts.length) {
    setState(db, STATE_KEYS.SINCE_ID, posts[posts.length - 1].id);
  }
  setState(db, STATE_KEYS.LAST_POLL_OK_AT, new Date().toISOString());
  setState(db, STATE_KEYS.LAST_POLL_ERROR, null);

  return { posts, primed: false };
}

/** Chooses the post source based on POST_SOURCE. */
export function getPostSource() {
  return config.postSource === 'replay' ? fetchReplayPosts : null;
}
