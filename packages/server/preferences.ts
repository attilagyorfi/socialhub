import { pool } from "../db";
import { DEFAULT_TIME_ZONE } from "../core/timezones";
import { transaction } from "./transaction";

export async function userPreferences(userId: string) {
  const result = await pool.query(`SELECT timezone FROM "user" WHERE id=$1`, [
    userId,
  ]);
  return {
    timezone: result.rows[0]?.timezone ?? DEFAULT_TIME_ZONE,
  };
}

export async function updateUserTimeZone(userId: string, timezone: string) {
  return transaction(async (tx) => {
    const current = (
      await tx.query(`SELECT timezone FROM "user" WHERE id=$1 FOR UPDATE`, [
        userId,
      ])
    ).rows[0];
    if (!current) throw new Error("Authenticated user no longer exists.");
    await tx.query(
      `UPDATE "user" SET timezone=$1,"updatedAt"=now() WHERE id=$2`,
      [timezone, userId],
    );
    if (current.timezone !== timezone)
      await tx.query(
        `INSERT INTO audit_logs(
           organization_id,client_id,actor_id,action,resource_id,metadata
         )
         SELECT organization_id,NULL,$1,'user.timezone.updated',$1,$2
         FROM organization_members WHERE user_id=$1`,
        [
          userId,
          JSON.stringify({
            previousTimezone: current.timezone,
            timezone,
          }),
        ],
      );
    return { timezone };
  });
}
