import { config, haikuEnabled } from '../config.js';
import { parseWithRegex } from './regex.js';
import { parseWithHaiku } from './haiku.js';

/**
 * Post parser entry point (INSTRUCTIONS.md §5).
 *
 * Strategy: always run the regex parser (it is free, synchronous, and never
 * fails), then run Haiku if it is configured. Haiku's classification wins
 * because it handles wording drift, but any field Haiku leaves empty is
 * back-filled from the regex result. That way a partial Haiku answer is
 * strictly better than either parser alone, and a total Haiku failure
 * degrades to plain regex rather than dropping the lesson.
 *
 * @returns {Promise<{
 *   parsed: object, parser: 'haiku'|'haiku+regex'|'regex',
 *   haikuError: string|null
 * }>}
 */
export async function parsePost(postText, opts = {}) {
  const regexResult = parseWithRegex(postText, opts);

  if (!haikuEnabled(config)) {
    return { parsed: regexResult, parser: 'regex', haikuError: null };
  }

  let haikuResult;
  try {
    haikuResult = await parseWithHaiku(postText, opts);
  } catch (err) {
    // Never let a parser failure lose a lesson — fall back and let the caller
    // record the error.
    return { parsed: regexResult, parser: 'regex', haikuError: err.message };
  }

  const merged = mergeParserResults(haikuResult, regexResult);
  const usedRegexField =
    merged.date !== haikuResult.date ||
    merged.start_time !== haikuResult.start_time ||
    merged.end_time !== haikuResult.end_time ||
    merged.areas.length !== haikuResult.areas.length;

  return {
    parsed: merged,
    parser: usedRegexField ? 'haiku+regex' : 'haiku',
    haikuError: null,
  };
}

/**
 * Haiku decides *what kind* of post this is; regex only fills gaps in the
 * extracted values. Exported for testing.
 */
export function mergeParserResults(haiku, regex) {
  // A post advertises several lessons. If Haiku found none but regex did, use
  // the regex set wholesale — mixing the two would pair one parser's times
  // with the other's towns, which is how you invent a lesson that never
  // existed. Whole-set fallback keeps every lesson internally consistent.
  const lessons = haiku.lessons?.length ? haiku.lessons : (regex.lessons ?? []);

  return {
    is_lesson_opening: haiku.is_lesson_opening,
    is_claim_notice: haiku.is_claim_notice,
    is_blanket_claim: haiku.is_blanket_claim,
    date: haiku.date ?? regex.date,
    lessons,
    start_time: haiku.start_time ?? regex.start_time,
    end_time: haiku.end_time ?? regex.end_time,
    areas: haiku.areas.length > 0 ? haiku.areas : regex.areas,
  };
}

export { parseWithRegex, parseWithHaiku };
