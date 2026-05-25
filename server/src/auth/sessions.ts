import { and, eq, gt } from "drizzle-orm";
import { database, sessions, users, generateUlid, type User } from "@lokyy/core";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = generateUlid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await database().insert(sessions).values({ id, userId, expiresAt });
  await database()
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, userId));
  return { id, expiresAt };
}

export async function getSessionUser(sessionId: string): Promise<User | null> {
  const now = new Date();
  const rows = await database()
    .select({
      user: users,
      sessionId: sessions.id,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!rows[0]) return null;

  // Sliding window: refresh expiresAt + last_used.
  await database()
    .update(sessions)
    .set({
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      lastUsedAt: now,
    })
    .where(eq(sessions.id, sessionId));

  return rows[0].user;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await database().delete(sessions).where(eq(sessions.id, sessionId));
}
