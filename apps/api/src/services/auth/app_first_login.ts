import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';

/**
 * First login to the app (a person in a browser), as opposed to account
 * creation: a voice call or aggregator can create the user long before they
 * open the app, so `created_at` cannot answer "is this their first visit".
 *
 * The marker is `user.tags.app_first_login_at`: absent until the first browser
 * session asks, then set once. Migration 0020 set it for pre-existing users.
 */
export const APP_FIRST_LOGIN_TAG = 'app_first_login_at';

/**
 * Claims the app's first login for `userId`: sets the marker if not yet set,
 * in one statement, so two racing first requests cannot both win.
 *
 * @returns true when this call set the marker (this is the first login).
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
