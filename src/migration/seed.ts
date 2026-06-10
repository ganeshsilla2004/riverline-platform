import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { getClient, closeClient } from "../db/client.js";
import { catalog, ensureCatalogIndexes } from "../db/catalog.js";
import { ensureTenantIndexes } from "../db/tenant.js";
import { ensureVaultIndexes, vault } from "../db/vault.js";
import { tenant } from "../db/tenant.js";
import { wrapKey } from "../lib/crypto.js";
import { tokenize, tokenizePhonesInText, clearKeyCache } from "../pii/tokenizer.js";
import { borrowerPiiFields } from "../pii/fields.js";
import { hashPassword } from "../auth/password.js";
import { config } from "../config.js";

interface SeedClient {
  _id: string; clientId: string; name: string; type: string; status: string;
  onboardedAt: string; contactEmail?: string; region?: string;
}
interface SeedBorrower {
  _id: string; borrowerId: string; clientId: string;
  firstName: string; lastName: string; fullName: string;
  phone: string; email: string; aadhaar: string; pan: string; bankAccount: string;
  assignedTo: string; status: string; dpdBucket: string;
  outstandingAmount: number; posAmount: number; tosAmount: number; settlementFloor: number;
  loanType: string; language: string; city: string;
  createdAt: string; updatedAt: string; createdBy: string; notes: string;
}
interface SeedConversation {
  _id: string; conversationId: string; borrowerId: string; clientId: string;
  channel: string; status: string;
  messages: { sender: "agent" | "borrower" | "system"; text: string; timestamp: string }[];
}
interface SeedPayment {
  _id: string; paymentId: string; borrowerId: string; clientId: string;
  amount: number; currency: string; method: string; status: string;
  reference: string; gatewayReference: string; channel: string;
  paidAt: string; createdAt: string;
}
interface SeedUser {
  _id: string; userId: string; name: string; email: string;
  role: "admin" | "debt-counselor" | "engineer" | "client-viewer";
  clientId: string; status: string; createdAt: string;
}
interface SeedAccessLog {
  _id: string; userId: string; userRole: string; clientId: string;
  method: string; path: string; statusCode: number; responseTimeMs: number;
  ipAddress: string; userAgent: string; timestamp: string;
}

const seedRoot = (): string =>
  resolve(process.env.SEED_DATA_PATH ?? "./seed-data");

const readJson = async <T>(name: string): Promise<T> => {
  const buf = await readFile(`${seedRoot()}/${name}`, "utf8");
  return JSON.parse(buf) as T;
};

const chunked = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const tokenizeBorrower = async (tenantId: string, raw: SeedBorrower) => ({
  _id: raw.borrowerId,
  borrowerId: raw.borrowerId,
  firstName: await tokenize(tenantId, "name", raw.firstName),
  lastName: await tokenize(tenantId, "name", raw.lastName),
  fullName: await tokenize(tenantId, "name", raw.fullName),
  phone: await tokenize(tenantId, "phone", raw.phone),
  email: await tokenize(tenantId, "email", raw.email),
  aadhaar: await tokenize(tenantId, "aadhaar", raw.aadhaar),
  pan: await tokenize(tenantId, "pan", raw.pan),
  bankAccount: await tokenize(tenantId, "bankAccount", raw.bankAccount),
  assignedTo: raw.assignedTo,
  status: raw.status,
  dpdBucket: raw.dpdBucket,
  outstandingAmount: raw.outstandingAmount,
  posAmount: raw.posAmount,
  tosAmount: raw.tosAmount,
  settlementFloor: raw.settlementFloor,
  loanType: raw.loanType,
  language: raw.language,
  city: raw.city,
  createdAt: new Date(raw.createdAt),
  updatedAt: new Date(raw.updatedAt),
  createdBy: raw.createdBy,
  notes: raw.notes,
});

// Reduce the access_logs into our new audit_log shape, redacting raw IDs out
// of the path string into resourceIds. Marks all entries as historical so
// they can be distinguished from logs the new system produced itself.
const reduceAccessLog = (raw: SeedAccessLog) => {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const ids = raw.path.match(uuidRe) ?? [];
  const pathTemplate = raw.path.replace(uuidRe, ":id");
  return {
    ts: new Date(raw.timestamp),
    userId: raw.userId,
    role: raw.userRole,
    tenantId: raw.clientId,
    method: raw.method,
    pathTemplate,
    resourceIds: ids,
    maskingLevel: "masked" as const,
    outcome: { statusCode: raw.statusCode, success: raw.statusCode < 400 },
    historical: true,
  };
};

export interface MigrateOptions {
  silent?: boolean;
}

export interface MigrateResult {
  skipped: boolean;
  durationMs: number;
  // Per-collection counts of records dropped because their clientId did not
  // match any tenant in the catalog. These are data-quality findings — the
  // OLD shared-DB system kept them since "separation" was by clientId field;
  // the new system rejects them because tenant identity must be authoritative.
  orphans: { borrowers: number; conversations: number; payments: number; accessLogs: number };
}

export const migrate = async (opts: MigrateOptions = {}): Promise<MigrateResult> => {
  const log = (msg: string): void => { if (!opts.silent) console.log(msg); };
  const start = Date.now();

  await getClient();
  await ensureCatalogIndexes();

  // Idempotency: if catalog.tenants is already populated, skip.
  const existingTenants = await (await catalog.tenants()).countDocuments();
  if (existingTenants > 0) {
    log(`migration: catalog already has ${existingTenants} tenants — skipping`);
    return {
      skipped: true,
      durationMs: Date.now() - start,
      orphans: { borrowers: 0, conversations: 0, payments: 0, accessLogs: 0 },
    };
  }
  borrowerPiiFields; // keep type alive

  log(`migration: reading seed data from ${seedRoot()}`);
  const [clients, borrowers, conversations, payments, users, accessLogs] = await Promise.all([
    readJson<SeedClient[]>("clients.json"),
    readJson<SeedBorrower[]>("borrowers.json"),
    readJson<SeedConversation[]>("conversations.json"),
    readJson<SeedPayment[]>("payments.json"),
    readJson<SeedUser[]>("users.json"),
    readJson<SeedAccessLog[]>("access_logs.json"),
  ]);

  log(`migration: ${clients.length} tenants, ${borrowers.length} borrowers, ${conversations.length} conversations, ${payments.length} payments, ${users.length} users, ${accessLogs.length} access logs`);

  // 1. Catalog: tenants, keys, users
  await (await catalog.tenants()).insertMany(clients.map((c) => ({
    _id: c._id,
    clientId: c.clientId,
    name: c.name,
    type: c.type,
    status: c.status,
    region: c.region,
    contactEmail: c.contactEmail,
    onboardedAt: new Date(c.onboardedAt),
  })));

  await (await catalog.tenantKeys()).insertMany(clients.map((c) => ({
    _id: c.clientId,
    wrappedKey: wrapKey(randomBytes(32), config.platformKey),
    createdAt: new Date(),
  })));

  // Hash the shared default password once and reuse across all seed users.
  const sharedHash = await hashPassword(config.seedUserPassword);
  await (await catalog.users()).insertMany(users.map((u) => ({
    _id: u.userId,
    userId: u.userId,
    email: u.email.toLowerCase(),
    name: u.name,
    role: u.role,
    clientId: u.clientId,
    status: u.status,
    passwordHash: sharedHash,
    createdAt: new Date(u.createdAt),
  })));

  // 2. Per-tenant DBs in parallel. Records with unknown/null clientId
  // are dropped and counted as orphans (data-quality finding).
  const validTenantIds = new Set(clients.map((c) => c.clientId));
  const isValid = (cid: string | null | undefined): cid is string =>
    typeof cid === "string" && validTenantIds.has(cid);

  const orphanCounts = {
    borrowers: borrowers.filter((b) => !isValid(b.clientId)).length,
    conversations: conversations.filter((c) => !isValid(c.clientId)).length,
    payments: payments.filter((p) => !isValid(p.clientId)).length,
    accessLogs: accessLogs.filter((a) => !isValid(a.clientId)).length,
  };
  if (orphanCounts.borrowers + orphanCounts.conversations +
      orphanCounts.payments + orphanCounts.accessLogs > 0) {
    log(`migration: data-quality findings — dropping orphan records ` +
      `(borrowers=${orphanCounts.borrowers}, conversations=${orphanCounts.conversations}, ` +
      `payments=${orphanCounts.payments}, accessLogs=${orphanCounts.accessLogs})`);
  }

  const borrowersByTenant = groupBy(borrowers.filter((b) => isValid(b.clientId)), (b) => b.clientId);
  const conversationsByTenant = groupBy(conversations.filter((c) => isValid(c.clientId)), (c) => c.clientId);
  const paymentsByTenant = groupBy(payments.filter((p) => isValid(p.clientId)), (p) => p.clientId);
  const accessLogsByTenant = groupBy(accessLogs.filter((a) => isValid(a.clientId)), (a) => a.clientId);

  await Promise.all(clients.map(async (c) => {
    const tenantId = c.clientId;
    await ensureTenantIndexes(tenantId);
    await ensureVaultIndexes(tenantId);

    // Borrowers: tokenize PII before write.
    const rawBs = borrowersByTenant.get(tenantId) ?? [];
    const tokenized = await Promise.all(rawBs.map((b) => tokenizeBorrower(tenantId, b)));
    if (tokenized.length > 0) {
      for (const batch of chunked(tokenized, 500)) {
        await (await tenant.borrowers(tenantId)).insertMany(batch, { ordered: false });
      }
    }
    log(`migration[${tenantId}]: ${tokenized.length} borrowers ingested`);

    // Conversations: scrub phone numbers from message text.
    const rawCs = conversationsByTenant.get(tenantId) ?? [];
    const convDocs = await Promise.all(rawCs.map(async (cv) => ({
      _id: cv.conversationId,
      conversationId: cv.conversationId,
      borrowerId: cv.borrowerId,
      channel: cv.channel,
      status: cv.status,
      messages: await Promise.all(cv.messages.map(async (m) => ({
        sender: m.sender,
        text: await tokenizePhonesInText(tenantId, m.text),
        timestamp: new Date(m.timestamp),
      }))),
    })));
    if (convDocs.length > 0) {
      for (const batch of chunked(convDocs, 200)) {
        await (await tenant.conversations(tenantId)).insertMany(batch, { ordered: false });
      }
    }
    log(`migration[${tenantId}]: ${convDocs.length} conversations ingested`);

    // Payments: no PII, copy as-is.
    const rawPs = paymentsByTenant.get(tenantId) ?? [];
    const payDocs = rawPs.map((p) => ({
      _id: p.paymentId,
      paymentId: p.paymentId,
      borrowerId: p.borrowerId,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      status: p.status,
      reference: p.reference,
      gatewayReference: p.gatewayReference,
      channel: p.channel,
      paidAt: new Date(p.paidAt),
      createdAt: new Date(p.createdAt),
    }));
    if (payDocs.length > 0) {
      for (const batch of chunked(payDocs, 500)) {
        await (await tenant.payments(tenantId)).insertMany(batch, { ordered: false });
      }
    }
    log(`migration[${tenantId}]: ${payDocs.length} payments ingested`);

    // Access logs → historical audit_logs
    const rawAs = accessLogsByTenant.get(tenantId) ?? [];
    if (rawAs.length > 0) {
      const auditDocs = rawAs.map(reduceAccessLog);
      for (const batch of chunked(auditDocs, 500)) {
        await (await tenant.auditLogs(tenantId)).insertMany(batch as any, { ordered: false });
      }
    }
    log(`migration[${tenantId}]: ${rawAs.length} access logs reduced into audit_logs`);
  }));

  const durationMs = Date.now() - start;
  log(`migration: complete in ${durationMs}ms`);
  return { skipped: false, durationMs, orphans: orphanCounts };
};

const groupBy = <T, K>(arr: T[], key: (x: T) => K): Map<K, T[]> => {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const cur = m.get(k);
    if (cur) cur.push(x);
    else m.set(k, [x]);
  }
  return m;
};

const isMainEntry = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(process.argv[1] ?? "") ||
      (process.argv[1]?.endsWith("seed.ts") ?? false) ||
      (process.argv[1]?.endsWith("seed.js") ?? false);
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  migrate().then(() => {
    clearKeyCache();
    return closeClient();
  }).then(() => process.exit(0))
    .catch((err) => {
      console.error("migration failed:", err);
      process.exit(1);
    });
}
