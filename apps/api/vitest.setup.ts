// Deterministic PII master key for tests so encrypt/decrypt round-trips
// without depending on a developer's local .env. 32 bytes of 0xA1 base64-encoded.
process.env.SIGNALS_PII_KEY ??= Buffer.alloc(32, 0xa1).toString('base64');
