import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const deriveKey = (passphrase: string): Buffer =>
  createHash("sha256").update(passphrase).digest();

export interface WrappedKey {
  iv: string;
  tag: string;
  ciphertext: string;
}

export const wrapKey = (plaintext: Buffer, passphrase: string): WrappedKey => {
  const key = deriveKey(passphrase);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ct.toString("hex"),
  };
};

export const unwrapKey = (wrapped: WrappedKey, passphrase: string): Buffer => {
  const key = deriveKey(passphrase);
  const iv = Buffer.from(wrapped.iv, "hex");
  const tag = Buffer.from(wrapped.tag, "hex");
  const ct = Buffer.from(wrapped.ciphertext, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};
