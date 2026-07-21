import { Hono } from "hono";
import { type Env, buildFleet } from "./cloudflare";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/fleet", async (c) => {
  try {
    const data = await buildFleet(c.env);
    return c.json(data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
