import nodemailer from 'nodemailer';
import { config } from './config.js';

/**
 * Gmail SMTP claim email (INSTRUCTIONS.md §6).
 *
 * A single post routinely advertises many hours, and several can match the
 * criteria at once. Rather than sending one email per hour — a burst of
 * requests for what is really one conversation — every matching lesson goes
 * into ONE email as a dash-bulleted list.
 *
 * NOT VERIFIED beyond a successful test send: the message body below has never
 * been read by the driving school. See README.md "What is untested".
 */

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // port 587 upgrades via STARTTLS
      auth: {
        user: config.email.address,
        pass: config.email.appPassword,
      },
      // A claim email that takes 30s to send has already lost the race. Fail
      // fast and let the next loop cycle retry.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-07-27" -> "July 27" */
export function formatMonthDay(isoDate) {
  const [, m, d] = isoDate.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "13:00" -> "1:00 PM" */
export function formatClockTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * "Needham" / "Needham/Wellesley" / "Needham/Dover/Natick".
 *
 * Slash-separated, mirroring the school's own notation ("5-6 pm
 * Needham/Westwood/Dover"). It also avoids the comma ambiguity that appears
 * once several lessons are listed together, and reads as a choice of town
 * rather than a lesson spanning all of them.
 */
export function formatAreas(areas) {
  if (!areas || areas.length === 0) return 'the listed area';
  return areas.join('/');
}

/** "1:00 PM-2:00 PM" — or just the start when no end time was published. */
function timeSpan(lesson) {
  const start = formatClockTime(lesson.start_time);
  return lesson.end_time ? `${start}-${formatClockTime(lesson.end_time)}` : start;
}

/** Sorts by date then start time so the email reads chronologically. */
function chronological(lessons) {
  return [...lessons].sort(
    (a, b) =>
      a.lesson_date.localeCompare(b.lesson_date) || a.start_time.localeCompare(b.start_time),
  );
}

/**
 * Builds the claim email. Accepts one lesson or many.
 *
 * A single lesson produces exactly the message from §6. Several produce the
 * same message with one dash-bulleted line per lesson, grouped under a shared
 * date when every lesson falls on the same day.
 *
 * Pure — used directly by tests.
 */
export function buildClaimEmail(lessonOrLessons, { fromName = config.email.fromName } = {}) {
  const lessons = chronological(
    Array.isArray(lessonOrLessons) ? lessonOrLessons : [lessonOrLessons],
  );

  if (lessons.length === 0) throw new Error('buildClaimEmail called with no lessons');

  const dates = [...new Set(lessons.map((l) => l.lesson_date))];
  const sameDay = dates.length === 1;

  // --- single lesson: the exact §6 template, unchanged ---------------------
  if (lessons.length === 1) {
    const l = lessons[0];
    const monthDay = formatMonthDay(l.lesson_date);
    const areaList = formatAreas(l.areas);

    return {
      subject: `Claiming lesson – ${monthDay}, ${timeSpan(l)} ${areaList}`,
      text: [
        'Hi,',
        '',
        `I'd like to claim the open lesson on ${monthDay} from ${timeSpan(l)} in ${areaList}.`,
        '',
        'Thanks,',
        fromName,
        '',
      ].join('\n'),
    };
  }

  // --- several lessons: one per bullet, not a comma-run ---------------------
  const items = lessons.map((l) =>
    sameDay
      ? `${timeSpan(l)} in ${formatAreas(l.areas)}`
      : `${formatMonthDay(l.lesson_date)} ${timeSpan(l)} in ${formatAreas(l.areas)}`,
  );

  const dateLabel = sameDay
    ? formatMonthDay(dates[0])
    : dates.map(formatMonthDay).join(' and ');

  // Long subjects get truncated by mail clients, so only inline the list when
  // it stays short. The body always carries the full detail.
  const inline = items.join(', ');
  const subject =
    inline.length <= 90
      ? `Claiming lessons – ${dateLabel}, ${inline}`
      : `Claiming ${lessons.length} lessons – ${dateLabel}`;

  const opening = sameDay
    ? `I'd like to claim the following open lessons on ${formatMonthDay(dates[0])}:`
    : "I'd like to claim the following open lessons:";

  return {
    subject,
    text: [
      'Hi,',
      '',
      opening,
      '',
      ...items.map((item) => `- ${item}`),
      '',
      '',
      'Thanks,',
      fromName,
      '',
    ].join('\n'),
  };
}

/**
 * Sends the claim email. Resolves only when SMTP confirms acceptance — the
 * caller must not record email_sent_at before this resolves (§6).
 *
 * @param {object|object[]} lessons one lesson, or every lesson to claim at once
 * @returns {Promise<{messageId: string, accepted: string[], dryRun: boolean}>}
 */
export async function sendClaimEmail(lessons, { dryRun = config.dryRun } = {}) {
  const { subject, text } = buildClaimEmail(lessons);

  if (dryRun) {
    console.log(`[email] DRY RUN — would send to ${config.email.to}\n  ${subject}`);
    return { messageId: 'dry-run', accepted: [config.email.to], dryRun: true };
  }

  const info = await getTransporter().sendMail({
    from: `"${config.email.fromName}" <${config.email.address}>`,
    to: config.email.to,
    subject,
    text,
  });

  // Nodemailer resolves even when a recipient was rejected — check explicitly
  // so we never mark a lesson claimed on an email that went nowhere.
  if (!info.accepted || info.accepted.length === 0) {
    throw new Error(`SMTP accepted no recipients (rejected: ${JSON.stringify(info.rejected)})`);
  }

  return { messageId: info.messageId, accepted: info.accepted, dryRun: false };
}

/** Verifies SMTP credentials without sending. Used by the dashboard. */
export async function verifyEmailConnection() {
  if (config.dryRun) return { ok: true, dryRun: true };
  await getTransporter().verify();
  return { ok: true, dryRun: false };
}
