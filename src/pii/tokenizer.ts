import { createHmac } from "node:crypto";
import { unwrapKey } from "../lib/crypto.js";
import { catalog } from "../db/catalog.js";
import { vault } from "../db/vault.js";
import { config } from "../config.js";
import { normalize, type PiiFieldType } from "./normalize.js";

// Pulled from a small fixed dictionary so tokenized names still *look* like names.
// Real systems would use a richer corpus; this is enough to make tokens visually
// distinguishable from raw inputs while preserving "first-last" shape.
const NAME_SYLLABLES = [
  "Ash", "Bha", "Cha", "Dha", "Eka", "Far", "Gop", "Han", "Ira", "Jay",
  "Kal", "Lav", "Mit", "Nav", "Om", "Pra", "Qad", "Ram", "Shi", "Tha",
  "Uma", "Var", "Yog", "Zoe", "Adi", "Bri", "Cit", "Div", "Eth", "Fri",
];

const keyCache = new Map<string, Buffer>();

const loadTenantKey = async (tenantId: string): Promise<Buffer> => {
  const cached = keyCache.get(tenantId);
  if (cached) return cached;
  const row = await (await catalog.tenantKeys()).findOne({ _id: tenantId });
  if (!row) throw new Error(`No tokenization key for tenant ${tenantId}`);
  const key = unwrapKey(row.wrappedKey, config.platformKey);
  keyCache.set(tenantId, key);
  return key;
};

const hmacBytes = (key: Buffer, value: string, suffix = ""): Buffer =>
  createHmac("sha256", key).update(value + suffix).digest();

const seedToBigInt = (bytes: Buffer, byteLen: number): bigint => {
  let n = 0n;
  for (let i = 0; i < byteLen; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n;
};

const formatPhone = (seed: Buffer): string =>
  (seedToBigInt(seed, 8) % 10_000_000_000n).toString().padStart(10, "0");

const formatAadhaar = (seed: Buffer): string =>
  (seedToBigInt(seed, 8) % 1_000_000_000_000n).toString().padStart(12, "0");

const formatBankAccount = (seed: Buffer, originalLength: number): string => {
  const mod = 10n ** BigInt(originalLength);
  return (seedToBigInt(seed, 8) % mod).toString().padStart(originalLength, "0");
};

const formatPan = (seed: Buffer): string => {
  // PAN: 5 letters + 4 digits + 1 letter
  let out = "";
  for (let i = 0; i < 5; i++) out += String.fromCharCode(65 + (seed[i] % 26));
  for (let i = 0; i < 4; i++) out += ((seed[5 + i] % 10).toString());
  out += String.fromCharCode(65 + (seed[9] % 26));
  return out;
};

const formatEmail = (seed: Buffer): string =>
  seed.subarray(0, 4).toString("hex") + "@masked.local";

const formatName = (seed: Buffer): string => {
  const first = NAME_SYLLABLES[seed[0] % NAME_SYLLABLES.length];
  const last = NAME_SYLLABLES[seed[1] % NAME_SYLLABLES.length] +
    NAME_SYLLABLES[seed[2] % NAME_SYLLABLES.length].toLowerCase();
  return `${first} ${last}`;
};

const deriveToken = (fieldType: PiiFieldType, seed: Buffer, raw: string): string => {
  switch (fieldType) {
    case "phone": return formatPhone(seed);
    case "aadhaar": return formatAadhaar(seed);
    case "pan": return formatPan(seed);
    case "email": return formatEmail(seed);
    case "bankAccount": return formatBankAccount(seed, raw.replace(/\D/g, "").length || 12);
    case "name": return formatName(seed);
  }
};

// Tokenize a value within the active tenant.
// Behavior: deterministic per (tenant, normalized value). The first time a value
// is seen, the token→value mapping is stored in the tenant's vault DB so the
// value is reversible by authorized roles. Subsequent calls with the same value
// regenerate the same token without writing.
//
// Collision handling: if the same token derives for two distinct raw values
// in the same tenant (vanishingly rare at this dataset size), we re-hash with
// a counter suffix until uniqueness holds.
export const tokenize = async (
  tenantId: string,
  fieldType: PiiFieldType,
  raw: string,
): Promise<string> => {
  if (raw == null || raw === "") return raw;
  const norm = normalize(fieldType, raw);
  if (!norm) return raw;
  const key = await loadTenantKey(tenantId);
  const tokens = await vault.tokens(tenantId);

  for (let attempt = 0; attempt < 5; attempt++) {
    const seed = hmacBytes(key, norm, attempt > 0 ? `:${attempt}` : "");
    const token = deriveToken(fieldType, seed, raw);

    const existing = await tokens.findOne({ _id: token });
    if (!existing) {
      try {
        await tokens.insertOne({
          _id: token,
          fieldType,
          value: raw,
          createdAt: new Date(),
        });
        return token;
      } catch {
        // Race on first insertion — re-fetch and verify
        const reread = await tokens.findOne({ _id: token });
        if (reread && reread.fieldType === fieldType &&
            normalize(reread.fieldType as PiiFieldType, reread.value) === norm) {
          return token;
        }
        continue;
      }
    }
    // Compare on NORMALIZED equivalence: two inputs that canonicalize to
    // the same value (e.g. "+91 99999 12345" and "9999912345") must map to
    // the same token. Anything else is a real cross-value collision.
    if (existing.fieldType === fieldType &&
        normalize(existing.fieldType as PiiFieldType, existing.value) === norm) {
      return token;
    }
  }
  throw new Error(`Token derivation collision exhausted for tenant=${tenantId} field=${fieldType}`);
};

export const detokenize = async (
  tenantId: string,
  token: string,
): Promise<string | null> => {
  if (!token) return null;
  const row = await (await vault.tokens(tenantId)).findOne({ _id: token });
  return row?.value ?? null;
};

// Replace any 10-digit phone numbers in free text with tokens.
// Used by the migration to scrub phone leaks out of conversation transcripts.
export const tokenizePhonesInText = async (
  tenantId: string,
  text: string,
): Promise<string> => {
  const re = /\b(\d{10})\b/g;
  const matches = Array.from(new Set(text.match(re) ?? []));
  let out = text;
  for (const m of matches) {
    const tok = await tokenize(tenantId, "phone", m);
    out = out.split(m).join(tok);
  }
  return out;
};

// Used by tests after migration teardown to make sure no key state leaks across tests.
export const clearKeyCache = (): void => {
  keyCache.clear();
};
