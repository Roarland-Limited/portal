import type { Env } from "./cloudflare";
import { buildFleet, probeHost } from "./cloudflare";

// A single missed deadline is not an outage. The fleet scan probes every host
// at once, so one slow origin — an uncached WordPress render, say — can miss
// its deadline partly because of the pile-up the scan itself created. Re-probe
// the failures on their own, spaced out, with a deadline no real site should
// need, and only believe the ones that fail every single time.
const CONFIRM_ATTEMPTS = 2;
const CONFIRM_DELAY_MS = 3_000;
const CONFIRM_TIMEOUT_MS = 25_000;
// Past this many hosts down at once it isn't a flaky probe, it's a tunnel or a
// box — confirming would only delay the mail by minutes. Also what bounds how
// long this whole check can run.
const CONFIRM_MAX_HOSTS = 3;

async function confirmOffline(items: MonitorItem[]): Promise<string[]> {
  // Devices are judged by Cloudflare's last_seen timestamp, not by a probe —
  // there is nothing to re-check, and the value doesn't flap.
  const suspects = items.filter((i) => i.kind === "host" && i.status === "offline");
  const falseAlarms: string[] = [];

  if (suspects.length > CONFIRM_MAX_HOSTS) return falseAlarms;

  for (const item of suspects) {
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
      const probe = await probeHost(item.label, CONFIRM_TIMEOUT_MS);
      if (probe.status !== "offline") {
        item.status = "online";
        falseAlarms.push(`${item.label} (recovered on confirm ${attempt}: ${probe.code_label}, ${probe.note})`);
        break;
      }
    }
  }

  return falseAlarms;
}

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
  falseAlarms: string[];
  emailed: boolean;
}

export async function runOfflineCheck(env: Env): Promise<CheckResult> {
  const items = await collectMonitorItems(env);
  const falseAlarms = await confirmOffline(items);

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

  return { checked: items.length, wentOffline, recovered, falseAlarms, emailed };
}
