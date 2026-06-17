import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../../../../examples/schemas/purple_dot/network.json');

type Prop = { private?: boolean; vectorize?: boolean; vector_weight?: number };

describe('purple_dot vectorize markers', () => {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const provider = cfg.domains.find((d: { id?: string }) => d.id === 'provider');
  const props: Record<string, Prop> = provider.item_schemas['profile_1.0'].properties;

  it('marks the two public free-text fields for vectorization', () => {
    expect(props.service_details.vectorize).toBe(true);
    expect(props.service_details.vector_weight).toBe(2);
    expect(props.services_offered.vectorize).toBe(true);
  });

  it('never marks a private property for vectorization', () => {
    for (const [, prop] of Object.entries(props)) {
      if (prop.private === true) expect(prop.vectorize).not.toBe(true);
    }
  });
});
