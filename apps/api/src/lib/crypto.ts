import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function hashPassword(pw: string) {
  // argon2id is the library default (algorithm 2)
  return argonHash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export async function verifyPassword(hash: string, pw: string) {
  try { return await argonVerify(hash, pw); } catch { return false; }
}

function key(secret: string, purpose: string) {
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
}
export function encrypt(secret: string, plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret, "enc"), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}
export function decrypt(secret: string, boxed: string) {
  const [iv, tag, data] = boxed.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(secret, "enc"), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString("utf8");
}

/** Small signed grant: payload.expiry.signature (used for share-link password unlocks). */
export function signGrant(secret: string, payload: string, ttlSec: number) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${payload}.${exp}`;
  return `${body}.${createHmac("sha256", key(secret, "grant")).update(body).digest("base64url")}`;
}
export function verifyGrant(secret: string, grant: string, payload: string) {
  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== payload) return false;
  if (parseInt(parts[1]!, 10) < Date.now() / 1000) return false;
  const expected = createHmac("sha256", key(secret, "grant")).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2]!, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
