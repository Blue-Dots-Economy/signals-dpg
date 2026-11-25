import z, {
  ALL_PHONE_COUNTRIES,
  parsePhone,
  PHONE_INPUT_SHAPE,
  type PhoneParseResult,
} from '@dpg/schemas';
import { authConfig } from '@/config';

/** Longest typed phone accepted: 15 digits plus room for spacing and punctuation. */
const PHONE_INPUT_MAX_LENGTH = 32;

/** Checks an identity phone (sign-in, OTP, participant): a mobile in a listed country. */
export function parseMobilePhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: authConfig.phone_countries, kind: 'mobile' });
}

/** Reads a phone that finds a stored user: any valid number, since older rules allowed more. */
export function parseKnownPhone(raw: string): PhoneParseResult {
  return parsePhone(raw, {
    countries: [authConfig.phone_countries[0], ...ALL_PHONE_COUNTRIES],
    kind: 'any',
  });
}

/** A typed mobile in E.164 (undefined when absent), refusing letters as the request fields do. */
export function cleanMobilePhone(
  raw: string | undefined,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (!raw) return { ok: true, value: undefined };
  const phone = parseMobilePhone(raw);
  return phone.ok ? { ok: true, value: phone.value } : { ok: false, message: phone.error.message };
}

/** Checks a contact phone (a number to call back), where landlines are fine. */
export function parseContactPhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: authConfig.phone_countries, kind: 'any' });
}

function phoneField(parse: (raw: string) => PhoneParseResult) {
  return z
    .string()
    .max(PHONE_INPUT_MAX_LENGTH)
    .regex(PHONE_INPUT_SHAPE)
    .transform((raw, ctx) => {
      const phone = parse(raw);
      if (phone.ok) return phone.value;
      ctx.addIssue({ code: 'custom', message: phone.error.message });
      return z.NEVER;
    });
}

/** A request field holding an identity phone; parses to E.164. */
export const MobilePhoneField = phoneField(parseMobilePhone);

/** A request field holding a callback phone (landlines allowed); parses to E.164. */
export const ContactPhoneField = phoneField(parseContactPhone);
