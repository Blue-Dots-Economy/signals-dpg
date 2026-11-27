/**
 * Thrown by startup configuration guards on an unsafe or incomplete
 * configuration, so boot fails visibly rather than starting misconfigured.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
