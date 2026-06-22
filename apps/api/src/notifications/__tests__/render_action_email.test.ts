import { describe, expect, it } from 'vitest';

import { renderActionEmail } from '../render_action_email';

const base = {
  network: 'blue_dot',
  brandName: 'Blue Dots',
  ctaUrl: 'https://app.example.com/auth/login',
};

describe('renderActionEmail — doc copy', () => {
  it('connect / seeker-facing / INBOUND_REQUEST: generic subject, service name in body', () => {
    const { subject, html } = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_REQUEST',
      recipientRole: 'seeker',
      counterpartyName: 'Acme Services',
      ...base,
    });
    expect(subject).toBe('A service provider wants to connect with you');
    expect(html).toContain('Acme Services has expressed interest in connecting with you');
    expect(html).toContain('https://app.example.com/auth/login');
    expect(html).toContain('Blue Dots');
    expect(html).toContain('View the details and respond');
  });

  it('connect / seeker-facing / OUTBOUND_REQUEST: service name in subject', () => {
    const { subject } = renderActionEmail({
      actionType: 'connect',
      shape: 'OUTBOUND_REQUEST',
      recipientRole: 'seeker',
      counterpartyName: 'Acme Services',
      ...base,
    });
    expect(subject).toBe('Your connection request has been sent to Acme Services');
  });

  it('connect / provider-facing / INBOUND_REQUEST: seeker stays generic', () => {
    const { subject, html } = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_REQUEST',
      recipientRole: 'provider',
      ...base,
    });
    expect(subject).toBe('A seeker wants to avail your service');
    expect(html).toContain('A seeker has shown interest in the service you’re offering');
  });

  it('apply / provider-facing / INBOUND_REQUEST', () => {
    const { subject } = renderActionEmail({
      actionType: 'apply',
      shape: 'INBOUND_REQUEST',
      recipientRole: 'provider',
      ...base,
    });
    expect(subject).toBe('A seeker has applied for your opportunity');
  });

  it('shortlist maps to the apply family copy', () => {
    const { subject } = renderActionEmail({
      actionType: 'shortlist',
      shape: 'OUTBOUND_REQUEST',
      recipientRole: 'provider',
      ...base,
    });
    expect(subject).toBe('Your shortlisting action has been sent to the seeker');
  });

  it('falls back to a generic service name when none is provided', () => {
    const { subject } = renderActionEmail({
      actionType: 'connect',
      shape: 'OUTBOUND_REQUEST',
      recipientRole: 'seeker',
      ...base,
    });
    expect(subject).toBe('Your connection request has been sent to the service provider');
  });

  it('uses the network brand colour for the CTA button', () => {
    const blue = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_REQUEST',
      recipientRole: 'provider',
      ...base,
    });
    expect(blue.html).toContain('background-color:#2563eb');

    const green = renderActionEmail({
      actionType: 'connect',
      shape: 'INBOUND_REQUEST',
      recipientRole: 'provider',
      ...base,
      network: 'green_dot',
    });
    expect(green.html).toContain('background-color:#16a34a');
    expect(green.html).not.toContain('#2563eb');
  });

  it('escapes the service name in the body but not the subject', () => {
    const { subject, html } = renderActionEmail({
      actionType: 'connect',
      shape: 'OUTBOUND_REQUEST',
      recipientRole: 'seeker',
      counterpartyName: 'Acme <script>',
      ...base,
    });
    expect(subject).toContain('Acme <script>');
    expect(html).toContain('Acme &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
