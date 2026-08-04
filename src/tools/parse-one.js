/**
 * Parse a single post from the command line, to see exactly what the bot would
 * make of it. Uses Haiku if ANTHROPIC_API_KEY is set, otherwise regex only.
 *
 *   npm run parse -- "Lesson Open Today July 27th: 1-2 pm Needham"
 */
import { parsePost } from '../parser/index.js';
import { config, haikuEnabled } from '../config.js';
import { evaluateLesson } from '../matcher.js';
import { openDatabase } from '../db.js';
import { getSettings } from '../settings.js';
import { todayInTz } from '../parser/normalize.js';

const text = process.argv.slice(2).join(' ');

if (!text) {
  console.error('Usage: npm run parse -- "<post text>"');
  process.exit(1);
}

const now = new Date();
const { parsed, parser, haikuError } = await parsePost(text, {
  now,
  timezone: config.timezone,
  postedOnDate: todayInTz(config.timezone, now),
});

console.log(`\nparser: ${parser}${haikuEnabled(config) ? '' : ' (no ANTHROPIC_API_KEY set)'}`);
if (haikuError) console.log(`haiku error: ${haikuError}`);
console.log(JSON.stringify(parsed, null, 2));

if (parsed.is_lesson_opening && parsed.date && parsed.start_time) {
  const db = openDatabase();
  const verdict = evaluateLesson(
    {
      lesson_date: parsed.date,
      start_time: parsed.start_time,
      end_time: parsed.end_time,
      areas: parsed.areas,
      status: 'open',
      email_sent_at: null,
    },
    getSettings(db),
  );
  console.log(
    `\nagainst your current settings: ${
      verdict.matches ? 'WOULD CLAIM' : `would skip (${verdict.skipReason})`
    }`,
  );
  if (verdict.effectiveEnd) {
    console.log(`effective window: ${parsed.start_time} – ${verdict.effectiveEnd} (incl. overrun buffer)`);
  }
  db.close();
}
