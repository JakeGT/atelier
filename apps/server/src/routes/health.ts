import { Hono } from "hono";

// Says only that the process is up and answering (what the container's health check and the
// deploy wait for). It does not ask the database or anything else.
export const health = new Hono().get("/healthz", (c) => c.json({ ok: true }));
