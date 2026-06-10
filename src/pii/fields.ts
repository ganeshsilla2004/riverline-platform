import type { PiiFieldType } from "./normalize.js";

// Per-collection registry of fields that hold PII and how to tokenize them.
// Adding a new PII field is a one-line change here; tokenizer + masking pick it up.
export const borrowerPiiFields: { name: keyof BorrowerLike; type: PiiFieldType }[] = [
  { name: "firstName", type: "name" },
  { name: "lastName", type: "name" },
  { name: "fullName", type: "name" },
  { name: "phone", type: "phone" },
  { name: "email", type: "email" },
  { name: "aadhaar", type: "aadhaar" },
  { name: "pan", type: "pan" },
  { name: "bankAccount", type: "bankAccount" },
];

export interface BorrowerLike {
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string;
  aadhaar: string;
  pan: string;
  bankAccount: string;
}
