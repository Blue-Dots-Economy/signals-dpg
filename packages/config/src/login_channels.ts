export type LoginChannel = 'email' | 'phone';

/**
 * Parses the LOGIN_CHANNELS env value into the ordered, de-duplicated set of
 * allowed login identifier channels. Accepts a comma-separated list of
 * `email` / `phone` (any case, whitespace tolerated). Throws on an unknown
 * entry or an empty result so a misconfiguration fails fast at boot.
 */
export function parseLoginChannels(input: string): LoginChannel[] {
  const seen = new Set<LoginChannel>();
  const result: LoginChannel[] = [];

  for (const raw of input.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry !== 'email' && entry !== 'phone') {
      throw new Error(
        `Invalid LOGIN_CHANNELS entry "${entry}". Allowed values: email, phone.`
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }

  if (result.length === 0) {
    throw new Error('LOGIN_CHANNELS must include at least one of: email, phone.');
  }

  return result;
}
