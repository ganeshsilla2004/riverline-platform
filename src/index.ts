import { buildApp } from "./server.js";
import { config } from "./config.js";
import { getClient, closeClient } from "./db/client.js";
import { ensureCatalogIndexes } from "./db/catalog.js";

const main = async (): Promise<void> => {
  await getClient();
  await ensureCatalogIndexes();

  if (config.autoMigrate) {
    const { migrate } = await import("./migration/seed.js");
    await migrate({ silent: false });
  }

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`API listening on :${config.port}`);
  });

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`${sig} received, shutting down`);
    server.close();
    await closeClient();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
