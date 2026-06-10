import type { Role } from "../db/context.js";
import { detokenize } from "../pii/tokenizer.js";
import type { BorrowerDoc } from "../db/tenant.js";

// Per-role visibility for each PII field. Three levels:
//   full     — original value returned (detokenized from vault)
//   partial  — last 4 chars revealed, rest replaced with *
//   masked   — token returned as-is (format-preserving placeholder)
//   omitted  — field stripped from the response entirely
// Compliance §4 says we MUST omit unauthorized fields, not return placeholders —
// "do not return masked placeholders for unauthorized fields, omit them entirely".
// We omit aadhaar/PAN/bank-account for client-viewer and engineer. We DO show
// masked placeholders to counselors for those, since counselors are authorized
// to know the *shape* (e.g., to verify a borrower is asking about the right
// account) without seeing the value.
type Level = "full" | "partial" | "masked" | "omitted";

const matrix: Record<Role, Record<string, Level>> = {
  admin: {
    firstName: "full", lastName: "full", fullName: "full",
    phone: "full", email: "full", aadhaar: "full", pan: "full", bankAccount: "full",
  },
  "debt-counselor": {
    firstName: "full", lastName: "full", fullName: "full",
    phone: "full", email: "full",
    aadhaar: "masked", pan: "masked", bankAccount: "masked",
  },
  engineer: {
    firstName: "masked", lastName: "masked", fullName: "masked",
    phone: "masked", email: "masked",
    aadhaar: "omitted", pan: "omitted", bankAccount: "omitted",
  },
  "client-viewer": {
    firstName: "masked", lastName: "masked", fullName: "masked",
    phone: "partial", email: "partial",
    aadhaar: "omitted", pan: "omitted", bankAccount: "omitted",
  },
};

const partial = (s: string): string => {
  if (!s || s.length <= 4) return "****";
  return "*".repeat(Math.max(0, s.length - 4)) + s.slice(-4);
};

const piiFields = [
  "firstName", "lastName", "fullName", "phone", "email", "aadhaar", "pan", "bankAccount",
] as const;

export const overallMaskingLevel = (role: Role): "full" | "partial" | "masked" => {
  const levels = piiFields.map((f) => matrix[role][f]);
  if (levels.every((l) => l === "full")) return "full";
  if (levels.some((l) => l === "full" || l === "partial")) return "partial";
  return "masked";
};

export const maskBorrower = async (
  tenantId: string,
  role: Role,
  doc: BorrowerDoc,
): Promise<Partial<BorrowerDoc>> => {
  const out: Record<string, unknown> = { ...doc };
  const ruleSet = matrix[role];
  for (const field of piiFields) {
    const level = ruleSet[field];
    const tokenValue = doc[field] as string;
    if (level === "omitted") {
      delete out[field];
      continue;
    }
    if (level === "masked") {
      out[field] = tokenValue;
      continue;
    }
    if (level === "partial") {
      out[field] = partial(tokenValue);
      continue;
    }
    if (level === "full") {
      const raw = await detokenize(tenantId, tokenValue);
      out[field] = raw ?? tokenValue;
    }
  }
  return out as Partial<BorrowerDoc>;
};
