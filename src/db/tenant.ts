import type { Collection, Db } from "mongodb";
import { getClient } from "./client.js";
import { config } from "../config.js";
import { currentContext } from "./context.js";

export interface BorrowerDoc {
  _id: string;
  borrowerId: string;
  // All PII fields below are TOKENS, not raw values.
  // Detokenize via vault.lookup() when authorized.
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string;
  aadhaar: string;
  pan: string;
  bankAccount: string;
  // Non-PII metadata
  assignedTo: string;
  status: string;
  dpdBucket: string;
  outstandingAmount: number;
  posAmount: number;
  tosAmount: number;
  settlementFloor: number;
  loanType: string;
  language: string;
  city: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  notes: string;
}

export interface ConversationDoc {
  _id: string;
  conversationId: string;
  borrowerId: string;
  channel: string;
  status: string;
  // Phone numbers in message text are replaced with tokens at ingest.
  messages: { sender: "agent" | "borrower" | "system"; text: string; timestamp: Date }[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PaymentDoc {
  _id: string;
  paymentId: string;
  borrowerId: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  reference: string;
  gatewayReference: string;
  channel: string;
  paidAt: Date;
  createdAt: Date;
}

export interface AuditLogDoc {
  _id?: string;
  ts: Date;
  userId: string;
  role: string;
  // The tenant whose data was accessed (may differ from user's home tenant
  // when an admin acts cross-tenant, or — for a breach — when isolation was violated).
  tenantId: string;
  // Method + route template, no raw IDs in path
  method: string;
  pathTemplate: string;
  resourceIds: string[];
  maskingLevel: "full" | "partial" | "masked";
  outcome: { statusCode: number; success: boolean; reason?: string };
  jti?: string;
  // Set true for cross-tenant attempts, scope violations, etc.
  securityIncident?: boolean;
}

export interface ComplianceReportDoc {
  _id: string;
  jobId: string;
  tenantId: string;
  requestedBy: string;
  requestedAt: Date;
  completedAt?: Date;
  status: "queued" | "running" | "completed" | "failed";
  summary?: {
    borrowerCount: number;
    activeBorrowers: number;
    closedBorrowers: number;
    paymentCount30d: number;
    quietHoursViolations: number;
    totalOutstanding: number;
    byDpdBucket: Record<string, number>;
  };
  error?: string;
}

const tenantDbName = (tenantId: string): string => `${config.tenantDbPrefix}${tenantId}`;

const tenantDb = async (tenantId?: string): Promise<Db> => {
  const t = tenantId ?? currentContext().activeTenantId ?? currentContext().tenantId;
  if (!t) throw new Error("Cannot resolve tenant DB: no tenant in context");
  return (await getClient()).db(tenantDbName(t));
};

export const tenant = {
  dbName: tenantDbName,
  raw: tenantDb,
  borrowers: async (tenantId?: string): Promise<Collection<BorrowerDoc>> =>
    (await tenantDb(tenantId)).collection<BorrowerDoc>("borrowers"),
  conversations: async (tenantId?: string): Promise<Collection<ConversationDoc>> =>
    (await tenantDb(tenantId)).collection<ConversationDoc>("conversations"),
  payments: async (tenantId?: string): Promise<Collection<PaymentDoc>> =>
    (await tenantDb(tenantId)).collection<PaymentDoc>("payments"),
  auditLogs: async (tenantId?: string): Promise<Collection<AuditLogDoc>> =>
    (await tenantDb(tenantId)).collection<AuditLogDoc>("audit_logs"),
  reports: async (tenantId?: string): Promise<Collection<ComplianceReportDoc>> =>
    (await tenantDb(tenantId)).collection<ComplianceReportDoc>("reports"),
};

export const ensureTenantIndexes = async (tenantId: string): Promise<void> => {
  const borrowers = await tenant.borrowers(tenantId);
  await borrowers.createIndex({ borrowerId: 1 }, { unique: true });
  await borrowers.createIndex({ assignedTo: 1 });
  const conv = await tenant.conversations(tenantId);
  await conv.createIndex({ borrowerId: 1 });
  const pay = await tenant.payments(tenantId);
  await pay.createIndex({ borrowerId: 1 });
  await pay.createIndex({ reference: 1 }, { unique: true });
  const audit = await tenant.auditLogs(tenantId);
  await audit.createIndex({ ts: -1 });
  await audit.createIndex({ userId: 1, ts: -1 });
};
