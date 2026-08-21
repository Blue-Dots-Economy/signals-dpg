import { describe, expect, it } from 'vitest';
import { loadSmsTemplateIndex, renderSmsPreview } from '../sms_templates';

describe('loadSmsTemplateIndex', () => {
  it('groups template_id / body / vars by case id', () => {
    const index = loadSmsTemplateIndex([
      [
        'profile.create.template_id=1507111',
        'profile.create.body=Ready {{name}}: {{link}}',
        'profile.create.vars=name, link',
      ].join('\n'),
    ]);

    const t = index.get('profile.create');
    expect(t).toEqual({
      templateId: '1507111',
      body: 'Ready {{name}}: {{link}}',
      vars: ['name', 'link'],
    });
  });

  it('treats a blank template_id as unconfigured (kept, empty)', () => {
    const index = loadSmsTemplateIndex(['profile.create.template_id=\nprofile.create.vars=name']);
    expect(index.get('profile.create')?.templateId).toBe('');
  });

  it('later layers override matching keys (default < network < brand)', () => {
    const index = loadSmsTemplateIndex([
      'profile.create.template_id=BASE\nprofile.create.body=base',
      'profile.create.template_id=NET', // network overrides id only
      'profile.create.body=brand copy', // brand overrides body only
    ]);
    const t = index.get('profile.create');
    expect(t?.templateId).toBe('NET');
    expect(t?.body).toBe('brand copy');
  });

  it('ignores keys without a known suffix', () => {
    const index = loadSmsTemplateIndex(['profile.create.subject=nope']);
    expect(index.has('profile.create')).toBe(false);
  });
});

describe('renderSmsPreview', () => {
  it('substitutes known tokens and leaves unknown ones intact', () => {
    expect(renderSmsPreview('Hi {{name}} at {{org}}', { name: 'Asha' })).toBe(
      'Hi Asha at {{org}}',
    );
  });
});
