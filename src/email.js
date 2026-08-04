import nodemailer from 'nodemailer';
import { config } from './config.js';

/**
 * Gmail SMTP claim email (INSTRUCTIONS.md §6).
 *
 * NOT VERIFIED — no message has been sent with a real App Password. The
 * transport config follows Gmail's documented SMTP settings. See README.md
 * "What is untested".
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

/** "Needham" / "Needham and Wellesley" / "Needham, Dover and Natick" */
export function formatAreas(areas) {
  if (!areas || areas.length === 0) return 'the listed area';
  if (areas.length === 1) return areas[0];
  return `${areas.slice(0, -1).join(', ')} and ${areas[areas.length - 1]}`;
}

/** Builds the exact message from the §6 template. Pure — used by tests. */
export function buildClaimEmail(lesson, { fromName = config.email.fromName } = {}) {
  const monthDay = formatMonthDay(lesson.lesson_date);
  const start = formatClockTime(lesson.start_time);
  const end = lesson.end_time ? formatClockTime(lesson.end_time) : null;
  const timeSpan = end ? `${start}-${end}` : start;
  const areaList = formatAreas(lesson.areas);

  const subject = `Claiming lesson – ${monthDay}, ${timeSpan} ${areaList}`;

  const text = [
    'Hi,',
    '',
    `I'd like to claim the open lesson on ${monthDay} from ${timeSpan} in ${areaList}.`,
    '',
    'Thanks,',
    fromName,
    '',
  ].join('\n');

  return { subject, text };
}

/**
 * Sends the claim email. Resolves only when SMTP confirms acceptance — the
 * caller must not record email_sent_at before this resolves (§6).
 *
 * @returns {Promise<{messageId: string, accepted: string[], dryRun: boolean}>}
 */
export async function sendClaimEmail(lesson, { dryRun = config.dryRun } = {}) {
  const { subject, text } = buildClaimEmail(lesson);

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
