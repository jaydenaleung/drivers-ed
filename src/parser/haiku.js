import Anthropic from '@anthropic-ai/sdk';
import { config, KNOWN_AREAS } from '../config.js';

/**
 * Claude Haiku post parser (INSTRUCTIONS.md §5).
 *
 * NOT VERIFIED AGAINST THE LIVE API — the API key on file is rejected, so this
 * path has never executed successfully. The request shape follows the current
 * Anthropic docs. See README.md "What is untested".
 *
 * The schema mirrors the regex parser: a post can advertise SEVERAL lessons,
 * so the model returns a `lessons` array rather than one time and one town
 * list. Returning a single merged lesson (the original design) both invents
 * lessons that do not exist and hides ones that do.
 */

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: config.anthropic.apiKey,
      // The SDK default is 10 MINUTES. For a bot racing to claim a lesson that
      // is unusable — we would rather fall back to regex in seconds than block
      // the polling loop. Retries are handled by the loop, not the SDK.
      timeout: 8000,
      maxRetries: 1,
    });
  }
  return client;
}

const SYSTEM_PROMPT = `You extract structured data from a driving school's social media posts.

The school posts when lesson slots open up, and posts again when they are taken.

A single opening post usually advertises SEVERAL separate lessons, one per line.
Two line formats occur:

  "8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover"
      -> FOUR lessons (08:00, 09:00, 10:00, 11:00), each one hour long, each
         available in Needham, Westwood or Dover.

  "5-6 pm Needham/Westwood/Dover"
      -> ONE lesson from 17:00 to 18:00 in those towns.

Rules:
- Each line's towns belong ONLY to that line. Never merge towns across lines.
  Two lines may list the same time with different towns; those are different
  lessons and must both be returned.
- A bare start time with no end time means a one-hour lesson: set end_time null.
- is_lesson_opening: true when the post ANNOUNCES available slots. Opening posts
  end with "Email ... to claim", which is an INVITATION, not a claim.
- is_claim_notice: true when the post says slots have ALREADY been taken
  ("has been claimed", "lessons have been claimed", "ALL HOURS ... CLAIMED").
  For a claim notice, return lessons: [].
- is_blanket_claim: true only when the notice covers everything ("All lessons
  have been claimed"), false for a specific one ("1 pm has been claimed").
- date: the date of the LESSONS in YYYY-MM-DD. "Today" means the date the post
  was published, which is given to you. A weekday name means the next such day
  on or after the post date. Null if no date can be determined.
- Driving lessons run in daylight hours, so "1-2" means 13:00-14:00.
- Ignore the town inside the school's own name or email address.

Return only the structured object. Do not explain.`;

/** JSON Schema for structured outputs. `additionalProperties: false` is required. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    is_lesson_opening: { type: 'boolean' },
    is_claim_notice: { type: 'boolean' },
    is_blanket_claim: { type: 'boolean' },
    date: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Lesson date as YYYY-MM-DD, or null',
    },
    lessons: {
      type: 'array',
      description: 'One entry per separately claimable lesson. Empty for claim notices.',
      items: {
        type: 'object',
        properties: {
          start_time: { type: 'string', description: '24-hour HH:MM' },
          end_time: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: '24-hour HH:MM, or null for a one-hour lesson',
          },
          areas: { type: 'array', items: { type: 'string', enum: KNOWN_AREAS } },
        },
        required: ['start_time', 'end_time', 'areas'],
        additionalProperties: false,
      },
    },
    claim_start_time: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'For a specific claim notice only: the claimed slot, HH:MM. Else null.',
    },
    claim_areas: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_AREAS },
      description: 'For a specific claim notice only: the towns named. Else empty.',
    },
  },
  required: [
    'is_lesson_opening',
    'is_claim_notice',
    'is_blanket_claim',
    'date',
    'lessons',
    'claim_start_time',
    'claim_areas',
  ],
  additionalProperties: false,
};

/**
 * @param {string} postText
 * @param {{ postedOnDate?: string }} [opts]
 *   postedOnDate resolves "today" and weekday names — pass the post's own
 *   publish date, not the current date.
 * @returns {Promise<object>} same shape as parseWithRegex
 * @throws if the API call fails or returns an unusable shape — the caller is
 *   expected to fall back to regex.
 */
export async function parseWithHaiku(postText, opts = {}) {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const postedOn = opts.postedOnDate ?? 'unknown';

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `This post was published on ${postedOn}.\n\nPost text:\n"""\n${postText}\n"""`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Haiku refused to process the post');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Haiku response was truncated (max_tokens)');
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Haiku returned no text block');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Haiku returned unparseable JSON: ${err.message}`);
  }

  return normaliseHaikuOutput(parsed);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const validDate = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
const validTime = (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);

function validAreas(raw) {
  if (!Array.isArray(raw)) return [];
  return KNOWN_AREAS.filter((a) => raw.some((r) => String(r).toLowerCase() === a.toLowerCase()));
}

/**
 * Structured outputs guarantee the *schema*, not the *semantics* — the model
 * can still hand back "1pm" or "Jul 27" as a string. Anything that does not
 * match the expected format is dropped so the caller falls back rather than
 * writing nonsense into the lessons table.
 */
export function normaliseHaikuOutput(raw) {
  const lessons = (Array.isArray(raw.lessons) ? raw.lessons : [])
    .map((l) => ({
      start_time: validTime(l?.start_time),
      end_time: validTime(l?.end_time),
      areas: validAreas(l?.areas),
    }))
    // A lesson with no usable start time is not actionable; drop it rather
    // than let it become a row we can never match.
    .filter((l) => l.start_time !== null);

  const isClaimNotice = Boolean(raw.is_claim_notice);

  return {
    is_lesson_opening: Boolean(raw.is_lesson_opening),
    is_claim_notice: isClaimNotice,
    is_blanket_claim: Boolean(raw.is_blanket_claim),
    date: validDate(raw.date),
    lessons: isClaimNotice ? [] : lessons,
    // Flat fields: for a claim notice they describe the claimed slot; for an
    // opening they mirror the first lesson, matching the regex parser.
    start_time: isClaimNotice ? validTime(raw.claim_start_time) : (lessons[0]?.start_time ?? null),
    end_time: isClaimNotice ? null : (lessons[0]?.end_time ?? null),
    areas: isClaimNotice ? validAreas(raw.claim_areas) : (lessons[0]?.areas ?? []),
  };
}
