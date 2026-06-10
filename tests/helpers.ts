import request, { type Agent } from "supertest";
import type { Application } from "express";
import { buildApp } from "../src/server.js";
import { migrate } from "../src/migration/seed.js";
import { reverseMigration } from "../src/migration/reverse.js";
import { closeClient } from "../src/db/client.js";

// Bootstrap a fresh DB state and a built express app. Tests must call
// `await bootstrap()` from beforeAll and `await teardown()` from afterAll
// to keep state isolated.
let app: Application | null = null;

export interface Bootstrap {
  app: Application;
  api: Agent;
}

export const bootstrap = async (): Promise<Bootstrap> => {
  await reverseMigration({ silent: true });
  await migrate({ silent: true });
  app = buildApp();
  return { app, api: request(app) };
};

export const teardown = async (): Promise<void> => {
  await closeClient();
  app = null;
};

// Seed credentials — every seed user has the same default password.
export const PASSWORD = "password123";

export const SEED = {
  sunriseAdmin: { email: "manoj.bose@gmail.com", clientId: "client_sunrise_001" },
  sunriseEngineer: { email: "rohitsingh@rediffmail.com", clientId: "client_sunrise_001" },
  // 3 sunrise counselors and the borrower assigned to each one (from seed data)
  sunriseCounselorAjay: {
    email: "ajay.menon@hotmail.com",
    userId: "5a96238c-71f0-4ef7-8d36-1ceeeb99412c",
    clientId: "client_sunrise_001",
    ownBorrower: "709dc7f4-65f0-4791-b4a7-367092ba16da",
  },
  sunriseCounselorHitesh: {
    email: "hitesh.mehta@rediffmail.com",
    userId: "e6ab3ef2-b475-46d9-85d6-652a1401e449",
    clientId: "client_sunrise_001",
    ownBorrower: "1c3a794b-e55f-4189-9a67-8fade6b3e4fa",
  },
  sunriseViewer: { email: "sachin_mukherjee1993@gmail.com", clientId: "client_sunrise_001" },
  metroAdmin: { email: "vivek.shah30@hotmail.com", clientId: "client_metro_002" },
  metroBorrowerSample: "3b6e0438-354c-4a01-801a-4ab741d14b66",
};

export const login = async (api: Agent, email: string): Promise<string> => {
  const res = await api.post("/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token as string;
};
