import crypto from 'crypto';

export interface NotificationAuthConfig {
  keyId: string;
  secret: string;
}

export interface NotificationAuthInput {
  method: string;
  /** Pathname only (e.g. "/notify"): no host, no query string. */
  path: string;
}

export function createNotificationAuthHeaders(
  { method, path }: NotificationAuthInput,
  { keyId, secret }: NotificationAuthConfig
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');

  const baseString = [method.toUpperCase(), path, timestamp, nonce].join('\n');

  const signature =
    'v1=' +
    crypto.createHmac('sha256', secret).update(baseString).digest('hex');

  return {
    'X-NS-Key': keyId,
    'X-NS-Timestamp': timestamp,
    'X-NS-Nonce': nonce,
    'X-NS-Signature': signature,
    'Content-Type': 'application/json',
  };
}
