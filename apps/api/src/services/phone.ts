import z, { parsePhone, PHONE_INPUT_SHAPE, type PhoneParseResult } from '@dpg/schemas';
import { authConfig } from '@/config';

/** Longest typed phone accepted: 15 digits plus room for spacing and punctuation. */
const PHONE_INPUT_MAX_LENGTH = 32;

/** Checks an identity phone (sign-in, OTP, participant): a mobile in a listed country. */
export function parseMobilePhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: authConfig.phone_countries, kind: 'mobile' });
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
