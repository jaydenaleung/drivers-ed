import { config } from './config.js';
import { formatMonthDay, formatClockTime, formatAreas } from './email.js';

/**
 * ntfy.sh phone push (INSTRUCTIONS.md §7).
 *
 * NOT VERIFIED — no push has been delivered to a real topic. See README.md
 * "What is untested".
 *
 * Per §7 a notification failure must NEVER un-send the email or change the
 * lesson status, so this function resolves with {ok:false} instead of throwing.
 * The caller logs it to the errors table and moves on.
 */
export async function notifyClaimSent(lesson, { dryRun = config.dryRun, fetchImpl = fetch } = {}) {
  const monthDay = formatMonthDay(lesson.lesson_date);
  const start = formatClockTime(lesson.start_time);
  const end = lesson.end_time ? `-${formatClockTime(lesson.end_time)}` : '';
  const areas = formatAreas(lesson.areas);

  const title = 'Lesson claim email sent';
  const body = `${monthDay}, ${start}${end} — ${areas}\nEmailed ${config.email.to}`;

  if (dryRun) {
    console.log(`[ntfy] DRY RUN — would push: ${title} / ${body.replace(/\n/g, ' | ')}`);
    return { ok: true, dryRun: true };
  }

  if (!config.ntfy.topic) {
    return { ok: false, error: 'NTFY_TOPIC is not set' };
  }

  try {
    const response = await fetchImpl(`${config.ntfy.server}/${config.ntfy.topic}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'car,white_check_mark',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { ok: false, error: `ntfy responded HTTP ${response.status}` };
    }

    return { ok: true, dryRun: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Used by the dashboard's "send test notification" button. */
export async function sendTestNotification({ fetchImpl = fetch } = {}) {
  if (!config.ntfy.topic) {
    return { ok: false, error: 'NTFY_TOPIC is not set' };
  }
  try {
    const response = await fetchImpl(`${config.ntfy.server}/${config.ntfy.topic}`, {
      method: 'POST',
      headers: { Title: 'Test from drivers-ed bot', Priority: 'default', Tags: 'wrench' },
      body: 'If you can read this, ntfy is wired up correctly.',
      signal: AbortSignal.timeout(10000),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: `ntfy responded HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
