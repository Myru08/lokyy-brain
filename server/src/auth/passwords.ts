import bcrypt from "bcrypt";

const COST = 12;
const BCRYPT_PREFIX = "bcrypt:";

export async function hashPassword(plain: string): Promise<string> {
  const hash = await bcrypt.hash(plain, COST);
  return `${BCRYPT_PREFIX}${hash}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  // Forward-compat: Story 1.10's setup endpoint used scrypt as a placeholder.
  if (stored.startsWith("scrypt:")) {
    const [, salt, expected] = stored.split(":");
    const { scryptSync } = await import("node:crypto");
    const actual = scryptSync(plain, salt, 64).toString("hex");
    return actual === expected;
  }
  if (stored.startsWith(BCRYPT_PREFIX)) {
    return bcrypt.compare(plain, stored.slice(BCRYPT_PREFIX.length));
  }
  return false;
}
