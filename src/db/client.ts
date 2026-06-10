import { MongoClient } from "mongodb";
import { config } from "../config.js";

let client: MongoClient | null = null;

export const getClient = async (): Promise<MongoClient> => {
  if (client) return client;
  const c = new MongoClient(config.mongoUrl, {
    maxPoolSize: config.maxPoolSize,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
  });
  await c.connect();
  client = c;
  return c;
};

export const closeClient = async (): Promise<void> => {
  if (client) {
    await client.close();
    client = null;
  }
};
