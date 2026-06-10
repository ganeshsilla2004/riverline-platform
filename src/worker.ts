import { Worker } from "bullmq";
import { QUEUE_NAME, getRedisConnection, type ComplianceJobData } from "./jobs/queue.js";
import { runComplianceReport } from "./jobs/complianceReport.js";
import { getClient, closeClient } from "./db/client.js";
import { ensureCatalogIndexes } from "./db/catalog.js";

const main = async (): Promise<void> => {
  await getClient();
  await ensureCatalogIndexes();

  const worker = new Worker<ComplianceJobData>(
    QUEUE_NAME,
    async (job) => runComplianceReport(job),
    {
      connection: getRedisConnection(),
      concurrency: 4,
    },
  );

  worker.on("completed", (job) => console.log(`job ${job.id} completed`));
  worker.on("failed", (job, err) => console.error(`job ${job?.id} failed:`, err.message));

  console.log(`Worker listening on queue "${QUEUE_NAME}"`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`${sig} received, shutting down worker`);
    await worker.close();
    await closeClient();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
