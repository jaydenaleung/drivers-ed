import {
  parseDateExpression,
  parseTimeRange,
  extractStartTimes,
  extractAreas,
  firstAreaIndex,
} from './normalize.js';

/**
 * Deterministic post parser (INSTRUCTIONS.md §5), rebuilt against the real
 * post formats observed on @NeedhamDriving rather than the single example in
 * the spec.
 *
 * Real opening posts contain SEVERAL lessons, one per line, in two shapes:
 *
 *   Lessons available on Sunday, 8/30!
 *
 *   8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover
 *   9 am, 1 pm or 2 pm - Needham, Westwood or Dedham
 *   9 am - Needham or Wellesley
 *
 *   Email info@needhamdrivingschool.com to claim!
 *
 * ...and:
 *
 *   Lessons Open Today:
 *
 *   5-6 pm Needham/Westwood/Dover
 *   5-6 pm Wellesley/Natick
 *   6-7 pm Needham/Wellesley
 *
 * Each line pairs a set of times with a set of towns, and every (time, towns)
 * pair is a separately claimable lesson. Merging them — as the first version
 * did — both invents lessons that do not exist and hides ones that do.
 */

/**
 * Text that would otherwise pollute area/keyword detection:
 * - the school's own name and email domain both contain "Needham"
 * - URLs can contain town names
 * Replacements preserve line structure so per-line parsing still works.
 */
function scrub(text) {
  return (text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/gi, ' ')
    .replace(/needham\s+driving\s+school/gi, ' ');
}

// Past-tense/state words meaning the slot is gone. Note "claimed", not "claim":
// opening posts end with "Email us to claim this hour", and matching bare
// "claim" there would invert the meaning of every opening post.
const CLAIM_STATE = /\b(claimed|taken|filled|booked|gone|spoken for|snapped up)\b/i;
const NO_LONGER = /\bno longer\s+(open|available)\b/i;
const BLANKET = /\b(all|every|everything)\b[^.!?]{0,40}?\b(claimed|taken|filled|booked|gone)\b/i;
const ALL_GONE = /\b(all|everything)\s+(is|are|has been|have been)?\s*(claimed|taken|filled|gone)\b/i;
const OPENING = /\b(open|opening|available|free|slot|spot)\b/i;
// Plurals matter. The school writes "Lessons available...", never "Lesson".
// The previous pattern required a word boundary straight after "lesson", so it
// did not match "Lessons" — which is why the parser rejected 100% of real
// opening posts while passing every test written from the spec's singular
// example.
const LESSON_WORD = /\b(lessons?|hours?|slots?|spots?|openings?|sessions?)\b/i;

/**
 * Parses one offer line into zero or more lessons.
 *
 * The split point between times and towns is the first town name, which
 * handles both the dash form ("3 pm or 4 pm - Needham only") and the bare form
 * ("5-6 pm Needham/Westwood/Dover") without needing to know which is which.
 *
 * @returns {Array<{start_time: string, end_time: string|null, areas: string[]}>}
 */
export function parseOfferLine(line) {
  const areas = extractAreas(line);
  if (areas.length === 0) return [];

  const splitAt = firstAreaIndex(line);
  const timeText = splitAt > 0 ? line.slice(0, splitAt) : '';
  if (!timeText.trim()) return [];

  // A dash between two clock times means one ranged lesson ("5-6 pm").
  const range = parseTimeRange(timeText);
  if (range.start && range.end) {
    return [{ start_time: range.start, end_time: range.end, areas }];
  }

  // Otherwise it is a list of one-hour starts ("8 am, 9 am, 10 am or 11 am").
  return extractStartTimes(timeText).map((start) => ({
    start_time: start,
    end_time: null,
    areas,
  }));
}

/**
 * @param {string} rawText
 * @param {{ timezone?: string, now?: Date, postedOnDate?: string }} [opts]
 * @returns {{
 *   is_lesson_opening: boolean, is_claim_notice: boolean, is_blanket_claim: boolean,
 *   date: string|null,
 *   lessons: Array<{start_time: string, end_time: string|null, areas: string[]}>,
 *   start_time: string|null, end_time: string|null, areas: string[]
 * }}
 */
export function parseWithRegex(rawText, opts = {}) {
  const text = scrub(rawText);

  const isBlanketClaim = BLANKET.test(text) || ALL_GONE.test(text);
  const hasClaimState = CLAIM_STATE.test(text) || NO_LONGER.test(text);

  // Claim state wins over opening words: "no longer available" contains
  // "available", and "1 pm has been claimed" still mentions a time.
  const isClaimNotice = isBlanketClaim || hasClaimState;

  const date = parseDateExpression(text, opts);

  if (isClaimNotice) {
    // A claim notice describes at most one slot ("1 pm has been claimed"), so
    // the flat fields are the right shape here.
    const { start, end } = parseTimeRange(text);
    return {
      is_lesson_opening: false,
      is_claim_notice: true,
      is_blanket_claim: isBlanketClaim,
      date,
      lessons: [],
      start_time: start,
      end_time: end,
      areas: extractAreas(text),
    };
  }

  // Deliberately NOT gated on having found a time. A post that reads like an
  // opening but whose times we failed to extract must still be flagged as an
  // opening so the pipeline can surface it as an error — classifying it as
  // "not a lesson" is how a real opening gets silently dropped.
  const looksLikeOpening = OPENING.test(text) && LESSON_WORD.test(text);

  const collected = [];
  if (looksLikeOpening) {
    for (const line of text.split(/\r?\n/)) {
      collected.push(...parseOfferLine(line));
    }
  }

  // De-duplicate within the post: the same time+towns listed twice is one lesson.
  const seen = new Set();
  const lessons = collected.filter((l) => {
    const key = `${l.start_time}|${l.end_time}|${l.areas.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    is_lesson_opening: looksLikeOpening,
    is_claim_notice: false,
    is_blanket_claim: false,
    date,
    lessons,
    // Flat fields describe the FIRST lesson, kept so anything reading the old
    // single-lesson shape still sees something sensible.
    start_time: lessons[0]?.start_time ?? null,
    end_time: lessons[0]?.end_time ?? null,
    areas: lessons[0]?.areas ?? [],
  };
}
