/**
 * Thrown by startup configuration guards when an unsafe combination of
 * environment variables is detected in production. Boot must fail non-zero
 * (visible crashloop) rather than start with an insecure configuration.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
