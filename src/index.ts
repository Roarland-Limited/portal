import { Hono } from "hono";
import { type Env, buildFleet } from "./cloudflare";
import { runOfflineCheck } from "./alerting";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/fleet", async (c) => {
  try {
    const data = await buildFleet(c.env);
    return c.json(data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/check-alerts", async (c) => {
  try {
    const result = await runOfflineCheck(c.env);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runOfflineCheck(env));
  },
};
