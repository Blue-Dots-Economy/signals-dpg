import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireAuthedUser } from '@/utils/authed_user_guard';

const makeReply = () => {
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return reply as unknown as FastifyReply & typeof reply;
};

const asRequest = (user: unknown) => ({ user }) as FastifyRequest;

describe('requireAuthedUser', () => {
  it('returns the user id and sends nothing when the request is authenticated', () => {
    const reply = makeReply();

    expect(requireAuthedUser(asRequest({ id: 'user-1' }), reply)).toBe('user-1');
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  // The exact 401 body 20 route handlers used to build by hand. Two route
  // tests (event/fetch_events, user/user_domains) assert on it end-to-end;
  // this pins the wording at the source.
  it('sends the unchanged 401 body and returns undefined when there is no user', () => {
    const reply = makeReply();

    expect(requireAuthedUser(asRequest(undefined), reply)).toBeUndefined();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  });

  it('uses the route-specific message when one is supplied', () => {
    const reply = makeReply();

    requireAuthedUser(asRequest(null), reply, 'Authenticated user is required to fetch events');

    expect(reply.send).toHaveBeenCalledWith({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch events',
    });
  });

  it('treats an empty user id as unauthenticated', () => {
    const reply = makeReply();

    expect(requireAuthedUser(asRequest({ id: '' }), reply)).toBeUndefined();
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
