import type { Filter } from "mongodb";
import { currentContext } from "../db/context.js";
import type { BorrowerDoc } from "../db/tenant.js";

// Inject debt-counselor scope INTO the query filter.
// For a counselor, every borrower query is rewritten to
//   { ...filter, assignedTo: <counselor userId> }
// so MongoDB never returns out-of-scope documents in the first place.
// This is enforcement at the data layer per spec §3.3, not post-fetch filtering.
export const scopeBorrowerFilter = (filter: Filter<BorrowerDoc> = {}): Filter<BorrowerDoc> => {
  const ctx = currentContext();
  if (ctx.role === "debt-counselor") {
    return { ...filter, assignedTo: ctx.userId };
  }
  return filter;
};

// For payment/conversation queries that target a single borrowerId, callers
// must first verify the borrower is in scope via this check (which uses the
// scoped borrower filter). Keeps the scope rule in one place.
