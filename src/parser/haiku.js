import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { KNOWN_AREAS } from '../config.js';

/**
 * Claude Haiku post parser (INSTRUCTIONS.md §5).
 *
 * NOT VERIFIED AGAINST THE LIVE API — see README.md "What is untested". The
 * request shape follows the current Anthropic docs, but no call has been made
 * with a real key, so treat the first live run as the real test. The regex
 * parser is the safety net either way.
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

The school (Needham Driving School) posts when a lesson slot opens up, and posts
again when a slot has been taken. Your job is to classify the post and pull out
the date, time and towns.

Rules:
- is_lesson_opening: true only when the post is ANNOUNCING an available slot.
  An opening post usually invites people to email to claim it. The phrase
  "email us to claim this hour" is an INVITATION, not a claim — that is still
  an opening.
- is_claim_notice: true when the post says a slot has ALREADY been taken
  ("claimed", "taken", "no longer available"), or announces that everything is
  gone ("All lessons have been claimed!").
- is_blanket_claim: true only for a claim notice covering ALL open lessons
  rather than one specific slot.
- date: the date of the LESSON in YYYY-MM-DD. "Today" means the date the post
  was published, which is given to you. Null if the post names no date.
- start_time / end_time: 24-hour HH:MM. Driving lessons run during daylight
  hours, so "1-2" means 13:00-14:00, not 01:00-02:00. Null if not stated.
- areas: any of the seven towns the school serves. Return [] if none named.
  Ignore the town inside the school's own name or email address.

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
      description: 'Lesson date as YYYY-MM-DD, or null if not stated',
    },
    start_time: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '24-hour HH:MM, or null',
    },
    end_time: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '24-hour HH:MM, or null',
    },
    areas: {
      type: 'array',
      items: { type: 'string', enum: KNOWN_AREAS },
    },
  },
  required: [
    'is_lesson_opening',
    'is_claim_notice',
    'is_blanket_claim',
    'date',
    'start_time',
    'end_time',
    'areas',
  ],
  additionalProperties: false,
};

/**
 * @param {string} postText
 * @param {{ postedOnDate?: string, timezone?: string }} [opts]
 *   postedOnDate resolves "today" — pass the post's own publish date, not the
 *   current date, so a post processed after midnight still resolves correctly.
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
    max_tokens: 1024,
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

/**
 * Structured outputs guarantee the *schema*, not the *semantics* — the model
 * can still hand back "1pm" or "Jul 27" as a string. Anything that does not
 * match the expected format becomes null so the caller can fall back rather
 * than write nonsense into the lessons table.
 */
export function normaliseHaikuOutput(raw) {
  const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const validTime = (v) =>
    typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;

  const areas = Array.isArray(raw.areas)
    ? KNOWN_AREAS.filter((a) => raw.areas.some((r) => String(r).toLowerCase() === a.toLowerCase()))
    : [];

  return {
    is_lesson_opening: Boolean(raw.is_lesson_opening),
    is_claim_notice: Boolean(raw.is_claim_notice),
    is_blanket_claim: Boolean(raw.is_blanket_claim),
    date: validDate(raw.date),
    start_time: validTime(raw.start_time),
    end_time: validTime(raw.end_time),
    areas,
  };
}
