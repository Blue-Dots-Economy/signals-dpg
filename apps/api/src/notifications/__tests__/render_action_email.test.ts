import { describe, expect, it } from 'vitest';

import { renderActionEmail } from '../render_action_email';

const base = {
  brandName: 'Blue Dot',
  ctaUrl: 'https://app.example.com/login',
};

describe('renderActionEmail', () => {
  it('INBOUND_REQUEST announces the counterparty action and asks to respond', () => {
    const { subject, html } = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_REQUEST',
      counterpartyLabel: 'a service provider',
      ...base,
    });
    expect(subject).toBe('A service provider wants to connect with you');
    expect(html).toContain('wants to connect with you');
    expect(html).toContain('https://app.example.com/login');
    expect(html).toContain('Blue Dot');
  });

  it('OUTBOUND_REQUEST confirms the request was sent to the counterparty', () => {
    const { subject } = renderActionEmail({
      actionType: 'connect',
      shape: 'OUTBOUND_REQUEST',
      counterpartyLabel: 'a seeker',
      ...base,
    });
    expect(subject).toBe('Your connection request has been sent to a seeker');
  });

  it('INBOUND_STATUS tells the requester the counterparty responded', () => {
    const { subject } = renderActionEmail({
      actionType: 'apply',
      shape: 'INBOUND_STATUS',
      counterpartyLabel: 'a service provider',
      ...base,
    });
    expect(subject).toBe('A service provider has responded to your application');
  });

  it('OUTBOUND_STATUS confirms the response was sent', () => {
    const { subject } = renderActionEmail({
      actionType: 'apply',
      shape: 'OUTBOUND_STATUS',
      counterpartyLabel: 'a seeker',
      ...base,
    });
    expect(subject).toBe('Your response to a seeker has been sent');
  });

  it('uses the counterparty name when one is provided (PII revealed)', () => {
    const { subject } = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_STATUS',
      counterpartyLabel: 'a service provider',
      counterpartyName: 'Acme Services',
      ...base,
    });
    expect(subject).toBe('Acme Services has responded to your connection request');
  });

  it('falls back to generic interaction copy for unknown action types', () => {
    const { subject } = renderActionEmail({
      actionType: 'mystery',
      shape: 'INBOUND_REQUEST',
      counterpartyLabel: 'another user',
      ...base,
    });
    expect(subject).toBe('Another user has taken an action on your profile');
  });

  it('escapes HTML in the counterparty name within the body but not the subject', () => {
    const { subject, html } = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_STATUS',
      counterpartyLabel: 'a service provider',
      counterpartyName: 'Acme <script>',
      ...base,
    });
    expect(subject).toContain('Acme <script>');
    expect(html).toContain('Acme &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
