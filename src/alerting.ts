import type { Env } from "./cloudflare";
import { buildFleet } from "./cloudflare";

export interface MonitorItem {
  id: string;
  kind: "host" | "device";
  label: string;
  detail: string;
  status: "online" | "offline";
  link: string;
}

export async function collectMonitorItems(env: Env): Promise<MonitorItem[]> {
  const fleet = await buildFleet(env);
  const items: MonitorItem[] = [];

  for (const zone of fleet.zones) {
    for (const group of zone.groups) {
      for (const host of group.hosts) {
        items.push({
          id: `host:${host.hostname}`,
          kind: "host",
          label: host.hostname,
          detail: `${zone.name} · ${group.title} · ${host.purpose}`,
          status: host.status === "offline" ? "offline" : "online",
          link: host.link,
        });
      }
    }
  }

  for (const d of fleet.devices) {
    items.push({
      id: `device:${d.id}`,
      kind: "device",
      label: d.name || d.id,
      detail: d.user_email ?? "WARP device",
      status: d.connected ? "online" : "offline",
      link: fleet.devices_dashboard_url,
    });
  }

  return items;
}

async function sendAlertEmail(
  env: Env,
  wentOffline: MonitorItem[],
  recovered: MonitorItem[]
): Promise<void> {
  const parts: string[] = [];
  if (wentOffline.length) {
    parts.push(
      `<h2 style="color:#c33d34;margin:0 0 8px">Went offline (${wentOffline.length})</h2><ul>` +
        wentOffline
          .map((i) => `<li><a href="${i.link}">${i.label}</a> — ${i.detail}</li>`)
          .join("") +
        `</ul>`
    );
  }
  if (recovered.length) {
    parts.push(
      `<h2 style="color:#1f8a54;margin:16px 0 8px">Back online (${recovered.length})</h2><ul>` +
        recovered
          .map((i) => `<li><a href="${i.link}">${i.label}</a> — ${i.detail}</li>`)
          .join("") +
        `</ul>`
    );
  }
  if (!parts.length) return;

  const subjectBits: string[] = [];
  if (wentOffline.length) subjectBits.push(`${wentOffline.length} offline`);
  if (recovered.length) subjectBits.push(`${recovered.length} recovered`);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Fleet Status <onboarding@resend.dev>",
      to: [env.ALERT_EMAIL_TO],
      subject: `[Fleet Status] ${subjectBits.join(", ")}`,
      html: `<div style="font-family:sans-serif">${parts.join("")}<p style="color:#8b93a7;font-size:12px;margin-top:20px">portal.roarland.net</p></div>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

export interface CheckResult {
  checked: number;
  wentOffline: MonitorItem[];
  recovered: MonitorItem[];
  emailed: boolean;
}

export async function runOfflineCheck(env: Env): Promise<CheckResult> {
  const items = await collectMonitorItems(env);

  const previousRaw = await env.FLEET_STATE.get("last_state");
  const previous: Record<string, string> = previousRaw ? JSON.parse(previousRaw) : {};

  const wentOffline: MonitorItem[] = [];
  const recovered: MonitorItem[] = [];

  for (const item of items) {
    const prevStatus = previous[item.id];
    if (item.status === "offline" && prevStatus !== "offline") {
      wentOffline.push(item);
    } else if (item.status === "online" && prevStatus === "offline") {
      recovered.push(item);
    }
  }

  let emailed = false;
  if (wentOffline.length || recovered.length) {
    await sendAlertEmail(env, wentOffline, recovered);
    emailed = true;
  }

  const nextState: Record<string, string> = {};
  for (const item of items) nextState[item.id] = item.status;
  await env.FLEET_STATE.put("last_state", JSON.stringify(nextState));

  return { checked: items.length, wentOffline, recovered, emailed };
}
