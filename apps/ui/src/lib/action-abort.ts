/**
 * Thrown by an action-submit handler that has already surfaced its own
 * user-facing message (e.g. a "complete your profile" prompt) and therefore
 * wants ActionHandler to skip its generic "something went wrong" error toast.
 */
export class ActionAbortedError extends Error {
  constructor(reason = 'action aborted') {
    super(reason);
    this.name = 'ActionAbortedError';
  }
}
