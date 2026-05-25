import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { systemConfig } from "../db/schema/systemConfig.js";

/**
 * Setup state — backed by `system_config.setup_complete` row.
 *
 * Story 1.10: server boots in setup mode if this key is absent or false.
 * Vault routes are gated server-side until `markSetupComplete()` is called
 * (Story 1.10 endpoint `POST /api/setup/complete`).
 */

const KEY = "setup_complete";

export async function isSetupComplete(): Promise<boolean> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, KEY))
    .limit(1);
  return rows[0]?.valueBool === true;
}

export async function markSetupComplete(): Promise<void> {
  const db = database();
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, KEY))
    .limit(1);

  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueBool: true, updatedAt: new Date() })
      .where(eq(systemConfig.key, KEY));
  } else {
    await db.insert(systemConfig).values({
      key: KEY,
      valueBool: true,
    });
  }
}

/** For tests / admin "reset setup" flows. */
export async function resetSetup(): Promise<void> {
  const db = database();
  await db
    .update(systemConfig)
    .set({ valueBool: false, updatedAt: new Date() })
    .where(eq(systemConfig.key, KEY));
}
