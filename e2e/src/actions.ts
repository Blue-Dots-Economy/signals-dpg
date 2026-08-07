import type { ApiResult } from './api-client.js';
import type { Session } from './auth.js';
import type { ItemRef } from './flows.js';

export interface ActionResultItem {
  index: number;
  status: 'success' | 'error';
  action_id?: string;
  action_type?: string;
  action_status?: string;
  update_count?: number;
  error?: string;
  message?: string;
}

export interface ActionEnvelope {
  results: ActionResultItem[];
  summary: { total: number; succeeded: number; failed: number };
}

/** The single result item, whether the call succeeded or returned a 422 envelope. */
function firstResult(res: ApiResult<ActionEnvelope>): ActionResultItem | undefined {
  return res.body?.results?.[0];
}

/**
 * Perform a single action. If the interaction requires consent
 * (`CONSENT_REQUIRED`), automatically retry once with a consent ack — so the
 * test asserts the happy outcome without hard-coding whether this network gates.
 */
/**
 * POST the perform body, tolerating both the current single-object contract and
 * older builds that still expect an array (pre-#296). The response envelope shape
 * is identical either way.
 */
async function postPerform(session: Session, bodyObj: Record<string, unknown>): Promise<ApiResult<ActionEnvelope>> {
  let res = await session.client.post<ActionEnvelope>('/api/v1/action/perform', bodyObj);
  if (res.status === 400 && /expected array/i.test(JSON.stringify(res.body))) {
    res = await session.client.post<ActionEnvelope>('/api/v1/action/perform', [bodyObj]);
  }
  return res;
}

/**
 * Perform an action and return the envelope **without throwing on failure**.
 *
 * `performAction` throws when the action doesn't succeed, which is right for the
 * happy paths but useless for the guards that are *supposed* to be refused
 * (pair cap, U18 channel block). Those need to read `results[0].error`.
 *
 * Consent is acknowledged up front here rather than on retry: a caller
 * asserting a specific refusal code doesn't want `CONSENT_REQUIRED` masking it.
 */
export async function tryPerformAction(
  session: Session,
  args: { actionType: string; source: ItemRef; target: ItemRef & { item_instance_url: string } },
  opts: { consentVersion?: number; guardianOtp?: string } = {},
): Promise<{ res: ApiResult<ActionEnvelope>; result?: ActionResultItem }> {
  const res = await postPerform(session, {
    action_type: args.actionType,
    source_item: args.source,
    target_item: args.target,
    requirements_snapshot: {},
    consent: { acknowledged: true, version: opts.consentVersion ?? 1 },
    ...(opts.guardianOtp ? { guardian_otp: opts.guardianOtp } : {}),
  });
  return { res, result: firstResult(res) };
}

export async function performAction(
  session: Session,
  args: { actionType: string; source: ItemRef; target: ItemRef & { item_instance_url: string } },
  opts: { consentVersion?: number } = {},
): Promise<{ actionId: string; actionStatus: string; res: ApiResult<ActionEnvelope> }> {
  const body = (withConsent: boolean) => ({
    action_type: args.actionType,
    source_item: args.source,
    target_item: args.target,
    requirements_snapshot: {},
    ...(withConsent ? { consent: { acknowledged: true, version: opts.consentVersion ?? 1 } } : {}),
  });

  let res = await postPerform(session, body(false));
  let item = firstResult(res);
  if (item?.status === 'error' && item.error === 'CONSENT_REQUIRED') {
    res = await postPerform(session, body(true));
    item = firstResult(res);
  }
  if (!item || item.status !== 'success' || !item.action_id) {
    throw new Error(`[e2e] action/perform did not succeed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { actionId: item.action_id, actionStatus: item.action_status ?? 'unknown', res };
}

/**
 * Update an action's status (array body). Auto-retries once with a consent ack
 * if the receiver-side status requires it.
 */
export async function updateActionStatus(
  session: Session,
  args: { actionId: string; status: string },
  opts: { consentVersion?: number } = {},
): Promise<{ actionStatus: string; res: ApiResult<ActionEnvelope> }> {
  const body = (withConsent: boolean) => [
    {
      action_id: args.actionId,
      action_status: args.status,
      // some networks' event_schema requires a remark; harmless when it doesn't
      remarks: 'e2e',
      ...(withConsent ? { consent: { acknowledged: true, version: opts.consentVersion ?? 1 } } : {}),
    },
  ];

  let res = await session.client.post<ActionEnvelope>('/api/v1/action/update-status', body(false));
  let item = res.body?.results?.[0];
  if (item?.status === 'error' && item.error === 'CONSENT_REQUIRED') {
    res = await session.client.post<ActionEnvelope>('/api/v1/action/update-status', body(true));
    item = res.body?.results?.[0];
  }
  if (!item || item.status !== 'success') {
    throw new Error(`[e2e] action/update-status did not succeed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { actionStatus: item.action_status ?? args.status, res };
}
