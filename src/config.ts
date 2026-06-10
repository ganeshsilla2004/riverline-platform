const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export const config = {
  mongoUrl: required("MONGO_URL", "mongodb://localhost:27017"),
  redis: {
    host: required("REDIS_HOST", "localhost"),
    port: parseInt(required("REDIS_PORT", "6379"), 10),
  },
  port: parseInt(required("PORT", "3000"), 10),
  platformKey: required("PLATFORM_KEY", "1".repeat(65)),
  jwtSecret: required("JWT_SECRET", "dev-only-jwt-secret"),
  webhookSecret: required("WEBHOOK_SECRET", "dev-only-webhook-secret"),
  seedUserPassword: required("SEED_USER_PASSWORD", "password123"),
  autoMigrate: process.env.AUTO_MIGRATE === "true",
  catalogDbName: "platform_catalog",
  tenantDbPrefix: "tenant_",
  vaultDbPrefix: "vault_",
  // 10 total connections across all tenant DBs — they share one MongoClient pool.
  maxPoolSize: 10,
  jwtExpirySeconds: 3600,
  quietHoursStartIST: 20,
  quietHoursEndIST: 8,
};
