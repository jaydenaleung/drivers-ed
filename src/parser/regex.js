import { parseDateExpression, parseTimeRange, extractAreas } from './normalize.js';

/**
 * Deterministic fallback parser (INSTRUCTIONS.md §5). Runs when the Haiku call
 * fails, times out, or is not configured — so one API hiccup never silently
 * drops a real lesson.
 */

/**
 * Text that would otherwise pollute area/keyword detection:
 * - the school's own name and email domain both contain "Needham"
 * - URLs can contain town names
 */
function scrub(text) {
  return text
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
const LESSON_WORD = /\b(lesson|hour|slot|spot|opening|session)\b/i;

/**
 * @param {string} rawText
 * @param {{ timezone?: string, now?: Date, postedAt?: string }} [opts]
 * @returns {{
 *   is_lesson_opening: boolean, is_claim_notice: boolean, is_blanket_claim: boolean,
 *   date: string|null, start_time: string|null, end_time: string|null, areas: string[]
 * }}
 */
export function parseWithRegex(rawText, opts = {}) {
  const text = scrub(rawText ?? '');

  const isBlanketClaim = BLANKET.test(text) || ALL_GONE.test(text);
  const hasClaimState = CLAIM_STATE.test(text) || NO_LONGER.test(text);

  const { start, end } = parseTimeRange(text);
  const date = parseDateExpression(text, opts);
  const areas = extractAreas(text);

  // Claim state wins over opening words: "no longer available" contains
  // "available", and "1-2pm Needham has been claimed" often still says "lesson".
  const isClaimNotice = isBlanketClaim || hasClaimState;

  // Deliberately NOT gated on having found a time. A post that reads like an
  // opening but whose time we failed to extract must still be flagged as an
  // opening so the pipeline can surface it as an error — classifying it as
  // "not a lesson" is how a real opening gets silently dropped.
  const isLessonOpening = !isClaimNotice && OPENING.test(text) && LESSON_WORD.test(text);

  return {
    is_lesson_opening: isLessonOpening,
    is_claim_notice: isClaimNotice,
    is_blanket_claim: isBlanketClaim,
    date,
    start_time: start,
    end_time: end,
    areas,
  };
}
