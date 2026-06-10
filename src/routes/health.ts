import { Router } from "express";
import { getClient } from "../db/client.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  try {
    const client = await getClient();
    await client.db("admin").command({ ping: 1 });
    res.json({ status: "ok", time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "degraded" });
  }
});
