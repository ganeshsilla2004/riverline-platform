import type { Job } from "bullmq";
import { runInContext, type TenantContext } from "../db/context.js";
import { tenant } from "../db/tenant.js";
import type { ComplianceJobData } from "./queue.js";

// IST quiet hours check, duplicated here to avoid pulling express into the worker bundle.
const hourInIST = (d: Date): number => {
  const utc = d.getTime();
  const istMs = utc + (5 * 60 + 30) * 60 * 1000;
  return new Date(istMs).getUTCHours();
};
const isQuietHourIST = (d: Date): boolean => {
  const h = hourInIST(d);
  return h >= 20 || h < 8;
};

export const runComplianceReport = async (job: Job<ComplianceJobData>): Promise<void> => {
  const { tenantId, requestedBy, reportId, requestedAt } = job.data;

  // The worker establishes a synthetic tenant context for this tenant.
  // Critical: this is what prevents the worker from accidentally querying
  // catalog-wide data or another tenant's DB. The async store carries the
  // tenant through all the DB accessors below.
  const ctx: TenantContext = {
    userId: requestedBy,
    role: "admin",
    tenantId,
    jti: `job:${job.id}`,
    activeTenantId: tenantId,
  };

  await runInContext(ctx, async () => {
    const reports = await tenant.reports(tenantId);
    await reports.updateOne(
      { _id: reportId },
      { $set: { status: "running" } },
    );

    try {
      const borrowers = await tenant.borrowers(tenantId);
      const payments = await tenant.payments(tenantId);
      const conversations = await tenant.conversations(tenantId);

      const [total, active, closed, byBucketAgg, payments30d] = await Promise.all([
        borrowers.countDocuments({}),
        borrowers.countDocuments({ status: "active" }),
        borrowers.countDocuments({ status: { $ne: "active" } }),
        borrowers.aggregate([{ $group: { _id: "$dpdBucket", n: { $sum: 1 } } }]).toArray(),
        payments.countDocuments({
          paidAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        }),
      ]);
      const totalOutstandingAgg = await borrowers.aggregate([
        { $group: { _id: null, sum: { $sum: "$outstandingAmount" } } },
      ]).toArray();

      // Quiet-hours violation count: count agent messages in IST 20:00-08:00.
      let quietHoursViolations = 0;
      const cursor = conversations.find({}, { projection: { messages: 1 } });
      for await (const doc of cursor) {
        for (const m of doc.messages ?? []) {
          if (m.sender === "agent" && isQuietHourIST(new Date(m.timestamp))) {
            quietHoursViolations++;
          }
        }
      }

      const byDpdBucket: Record<string, number> = {};
      for (const row of byBucketAgg) byDpdBucket[String(row._id)] = row.n as number;

      await reports.updateOne(
        { _id: reportId },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            summary: {
              borrowerCount: total,
              activeBorrowers: active,
              closedBorrowers: closed,
              paymentCount30d: payments30d,
              quietHoursViolations,
              totalOutstanding: (totalOutstandingAgg[0]?.sum as number | undefined) ?? 0,
              byDpdBucket,
            },
          },
        },
      );
    } catch (err) {
      await reports.updateOne(
        { _id: reportId },
        {
          $set: {
            status: "failed",
            completedAt: new Date(),
            error: err instanceof Error ? err.message : String(err),
          },
        },
      );
      throw err;
    }
    void requestedAt;
  });
};
