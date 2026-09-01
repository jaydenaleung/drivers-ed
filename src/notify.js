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
export async function notifyClaimSent(
  lessonOrLessons,
  { dryRun = config.dryRun, fetchImpl = fetch } = {},
) {
  const lessons = Array.isArray(lessonOrLessons) ? lessonOrLessons : [lessonOrLessons];

  const describe = (l) => {
    const end = l.end_time ? `-${formatClockTime(l.end_time)}` : '';
    return `${formatMonthDay(l.lesson_date)}, ${formatClockTime(l.start_time)}${end} — ${formatAreas(l.areas)}`;
  };

  // One email covers every matching lesson, so one push describes them all.
  const title =
    lessons.length === 1 ? 'Lesson claim email sent' : `${lessons.length} lesson claims sent`;
  const body = `${lessons.map(describe).join('\n')}\nEmailed ${config.email.to}`;

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
