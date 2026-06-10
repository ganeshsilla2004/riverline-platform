export type PiiFieldType =
  | "phone"
  | "aadhaar"
  | "pan"
  | "email"
  | "bankAccount"
  | "name";

// Normalization makes tokens stable across formatting differences in the input.
// "+91 79 3604 3811" and "7936043811" must hash to the same seed.
export const normalize = (fieldType: PiiFieldType, raw: string): string => {
  switch (fieldType) {
    case "phone":
      return raw.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "").slice(-10);
    case "aadhaar":
      return raw.replace(/\D/g, "");
    case "pan":
      return raw.toUpperCase().replace(/\s+/g, "");
    case "email":
      return raw.toLowerCase().trim();
    case "bankAccount":
      return raw.replace(/\D/g, "");
    case "name":
      return raw.trim().replace(/\s+/g, " ").toLowerCase();
  }
};
