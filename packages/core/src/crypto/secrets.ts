/**
 * Symmetric secret encryption for at-rest sensitive values (Forgejo OAuth
 * access/refresh tokens being the first consumer; more to follow).
 *
 * Algorithm: AES-256-GCM with a 96-bit IV and a 128-bit auth tag. The
 * 256-bit key is derived from the master secret `process.env.LOKYY_DATA_KEY`
 * via PBKDF2(HMAC-SHA256) with a fixed application-wide salt and 200k
 * iterations. Key derivation is memoised — the env var is read once per
 * process and the derived key cached for the lifetime of the process.
 *
 *   envelope := base64( iv (12 bytes) || authTag (16 bytes) || ciphertext )
 *
 * Env-var contract:
 *
 *   LOKYY_DATA_KEY  — OPTIONAL.
 *
 *     - Unset / empty           → encrypt / decrypt are no-ops. The plaintext
 *                                 is returned unchanged. A single warning is
 *                                 logged the first time the helpers are used.
 *                                 Intended for dev / test environments and
 *                                 backwards compatibility with rows that pre-
 *                                 date this feature; PRODUCTION MUST SET IT.
 *
 *     - Set to a non-empty str  → encrypt produces a base64 envelope, decrypt
 *                                 reverses it. `decrypt` of a plaintext value
 *                                 (legacy row stored before this feature was
 *                                 wired) returns the input verbatim — the
 *                                 envelope is identifiable by its strict
 *                                 base64 + minimum-length shape, and anything
 *                                 that doesn't match is assumed plaintext.
 *                                 This keeps the migration path forgiving:
 *                                 set the key, write new rows encrypted, read
 *                                 old rows transparently until they rotate.
 *
 * Key rotation (FUTURE STORY — not implemented here):
 *
 *   1. Generate the new key, set it as `LOKYY_DATA_KEY_NEXT`.
 *   2. Bring up an admin route that re-encrypts every secret column with the
 *      next key (read with current key, write with next key, in a single
 *      transaction per row).
 *   3. After the re-encrypt batch finishes, promote `LOKYY_DATA_KEY_NEXT` →
 *      `LOKYY_DATA_KEY` and drop the old key from the environment.
 *
 *   The envelope format leaves space for a key-id prefix (e.g. `v2:<b64>`)
 *   when we get there; current envelopes are unprefixed and treated as
 *   `v1` implicitly. Keep that in mind when designing the rotation route.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit IV — NIST recommended for GCM
const TAG_LEN = 16; // 128-bit auth tag
const KEY_LEN = 32; // 256-bit key
const SALT = Buffer.from("lokyy-brain:secrets:v1", "utf8");
const PBKDF2_ITER = 200_000;
const PBKDF2_DIGEST = "sha256";

let cachedKey: Buffer | null | undefined; // undefined = not yet computed
let warnedAboutMissingKey = false;

/**
 * Derive (and memoise) the symmetric key from `LOKYY_DATA_KEY`. Returns
 * `null` when the env var is missing/empty, which puts the helpers into
 * pass-through mode.
 */
function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const secret = process.env.LOKYY_DATA_KEY;
  if (!secret || secret.length === 0) {
    cachedKey = null;
    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true;
      console.warn(
        "[crypto/secrets] LOKYY_DATA_KEY is not set — Forgejo OAuth tokens " +
          "and other at-rest secrets will be stored in plaintext. Set " +
          "LOKYY_DATA_KEY in production to enable AES-256-GCM encryption.",
      );
    }
    return null;
  }
  cachedKey = pbkdf2Sync(secret, SALT, PBKDF2_ITER, KEY_LEN, PBKDF2_DIGEST);
  return cachedKey;
}

/**
 * Force re-derivation on next call. Test-only — exported for completeness.
 */
export function _resetKeyCacheForTests(): void {
  cachedKey = undefined;
  warnedAboutMissingKey = false;
}

/**
 * Encrypt `plaintext`. Returns:
 *   - the original `plaintext` if `LOKYY_DATA_KEY` is unset
 *   - a base64-encoded `iv || authTag || ciphertext` envelope otherwise
 *
 * Empty / null-ish inputs short-circuit to themselves: encrypting an empty
 * string is meaningless and the schema columns are nullable for the refresh
 * token anyway.
 */
export function encrypt(plaintext: string): string {
  if (plaintext === "" || plaintext === null || plaintext === undefined) {
    return plaintext;
  }
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt an envelope produced by `encrypt`. Behavior:
 *
 *   - empty / null input            → returned unchanged
 *   - input doesn't look like an    → returned unchanged (legacy plaintext)
 *     envelope (or no key set)
 *   - looks like an envelope and    → decrypted plaintext
 *     key is set
 *
 * "Looks like an envelope" = valid base64 of length >= IV+TAG+1.
 * GCM auth-tag verification will reject anything that isn't actually
 * ciphertext produced under the current key — those throws are converted
 * into a thrown `Error` (we do NOT silently return garbage on tampering).
 */
export function decrypt(envelope: string): string {
  if (envelope === "" || envelope === null || envelope === undefined) {
    return envelope;
  }
  const key = getKey();
  if (!key) return envelope;
  if (!looksLikeEnvelope(envelope)) {
    // Legacy plaintext row written before the encryption feature was wired,
    // or a value that's intentionally cleartext. Pass it through.
    return envelope;
  }
  const buf = Buffer.from(envelope, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Cheap structural check. We are conservative on purpose — a "looks like an
 * envelope" false positive on a plaintext value would crash decrypt; a false
 * negative simply skips decryption and returns the value untouched, which is
 * the right behavior for legacy plaintext rows.
 */
function looksLikeEnvelope(s: string): boolean {
  // base64 alphabet only, length divisible by 4, and long enough to contain
  // iv + tag + at least one ciphertext byte once decoded.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  // base64 chars expand to 3 bytes per 4 chars; min envelope = IV+TAG+1 = 29 bytes,
  // which encodes to ceil(29 / 3) * 4 = 40 base64 chars.
  if (s.length < 40) return false;
  try {
    const buf = Buffer.from(s, "base64");
    return buf.length >= IV_LEN + TAG_LEN + 1;
  } catch {
    return false;
  }
}

/**
 * True if the env var is set and a key was derived. Used by startup
 * banners / health endpoints to surface the at-rest encryption posture.
 */
export function isEncryptionConfigured(): boolean {
  return getKey() !== null;
}
