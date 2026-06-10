import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";

export const QUEUE_NAME = "compliance-reports";

let queue: Queue | null = null;
let connection: IORedis | null = null;

const buildConnection = (): IORedis => {
  if (connection) return connection;
  connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  });
  return connection;
};

export const getComplianceQueue = (): Queue => {
  if (queue) return queue;
  queue = new Queue(QUEUE_NAME, { connection: buildConnection() });
  return queue;
};

export const getRedisConnection = (): IORedis => buildConnection();

export interface ComplianceJobData {
  tenantId: string;
  requestedBy: string;
  reportId: string;
  requestedAt: string;
}
