import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';

/**
 * First login TO THE APP (a person in a browser), as opposed to the account
 * being created. A voice call or an aggregator can create the user and their
 * profile over a service credential long before that person ever opens the
 * app, so `created_at` cannot answer "is this their first visit".
 *
 * The marker is `user.tags.app_first_login_at` (ISO timestamp): absent until
 * the first browser session asks, then set once and never changed. Existing
 * users were given it by migration 0020, so only people who have never used
 * the app count as first-timers.
 */
export const APP_FIRST_LOGIN_TAG = 'app_first_login_at';

/**
 * Claims the app's first login for `userId`: sets the marker if it is not
 * set yet, in one statement, so two first requests racing each other cannot
 * both win.
 *
 * @returns true when this call set the marker — this IS the first login.
 */
export async function claimAppFirstLogin(userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE "user"
       SET tags = tags || jsonb_build_object(${APP_FIRST_LOGIN_TAG}::text, to_jsonb(now()))
     WHERE id = ${userId}
       AND NOT (tags ? ${APP_FIRST_LOGIN_TAG}::text)
    RETURNING id
  `);
  return result.rows.length > 0;
}
