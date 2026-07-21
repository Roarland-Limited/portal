export interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
  ALERT_EMAIL_TO: string;
  FLEET_STATE: KVNamespace;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

async function cfFetch<T>(env: Env, path: string): Promise<{ success: boolean; result: T | null; errors: unknown[] }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return (await res.json()) as { success: boolean; result: T | null; errors: unknown[] };
}

interface CfZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
}

interface CfDnsRecord {
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

interface CfTunnel {
  id: string;
  name: string;
  status: string;
}

interface CfTunnelIngress {
  hostname?: string;
  service: string;
}

interface CfWorkerDomain {
  hostname: string;
  service: string;
}

export interface CfDevice {
  id: string;
  name: string;
  user?: { email?: string };
  device_type?: string;
  last_seen?: string;
}

export type HostStatus = "online" | "gated" | "degraded" | "offline";
export type HostGroupKey = "tunnel" | "direct" | "worker";

export interface HostCard {
  hostname: string;
  purpose: string;
  target: string;
  link: string;
  status: HostStatus;
  code_label: string;
  note: string;
}

export interface HostGroup {
  key: HostGroupKey;
  title: string;
  note: string;
  hosts: HostCard[];
}

export interface ZoneFleet {
  name: string;
  cf_status: string;
  groups: HostGroup[];
  stats: Record<HostStatus, number>;
  dashboard_url: string;
}

const GROUP_META: Record<HostGroupKey, { title: string; note: string }> = {
  tunnel: {
    title: "Cloudflare Tunnel",
    note: "Routed through cloudflared — CNAME target ends in cfargotunnel.com",
  },
  direct: {
    title: "Direct record",
    note: "DNS points straight at a target — proxied rows go through Cloudflare, DNS-only hit the origin directly",
  },
  worker: {
    title: "Cloudflare Workers",
    note: "Served at the edge by a Worker, no origin server to lose",
  },
};

async function probeHost(hostname: string): Promise<{
  status: HostStatus;
  http_status: number | null;
  latency_ms: number | null;
  code_label: string;
  note: string;
}> {
  const start = Date.now();
  try {
    const res = await fetch(`https://${hostname}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    const latency = Date.now() - start;
    let finalHost = "";
    try {
      finalHost = new URL(res.url).hostname;
    } catch {
      /* ignore */
    }
    if (finalHost.endsWith("cloudflareaccess.com")) {
      return {
        status: "gated",
        http_status: res.status,
        latency_ms: latency,
        code_label: `HTTP ${res.status}`,
        note: "Redirects to Cloudflare Access login — healthy",
      };
    }
    if (res.status < 500) {
      return {
        status: "online",
        http_status: res.status,
        latency_ms: latency,
        code_label: `HTTP ${res.status}`,
        note: `${latency} ms`,
      };
    }
    return {
      status: "degraded",
      http_status: res.status,
      latency_ms: latency,
      code_label: `HTTP ${res.status}`,
      note: res.status >= 520 && res.status <= 530 ? "TLS/connection handshake with origin failed" : `Origin returned HTTP ${res.status}`,
    };
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      status: "offline",
      http_status: null,
      latency_ms: null,
      code_label: isTimeout ? "Timeout" : "No response",
      note: isTimeout ? "No response within 6s" : "Connection failed",
    };
  }
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function tunnelPurpose(service: string): string {
  if (service.startsWith("ssh://")) return "SSH via tunnel";
  if (service.startsWith("rdp://")) return "RDP via tunnel";
  const m = service.match(/^https?:\/\/[^:/]+:(\d+)/);
  if (m) {
    const port = m[1];
    return port === "80" || port === "443" ? "Web service" : `Web service, port ${port}`;
  }
  if (service.startsWith("http://") || service.startsWith("https://")) return "Web service";
  return "Tunnel route";
}

export async function buildFleet(env: Env): Promise<{
  generated_at: string;
  zones: ZoneFleet[];
  devices: Array<{
    id: string;
    name: string;
    user_email: string | null;
    device_type: string | null;
    last_seen: string | null;
    connected: boolean;
  }>;
  devices_dashboard_url: string;
}> {
  const [zonesRes, tunnelsRes, workerDomainsRes, devicesRes] = await Promise.all([
    cfFetch<CfZone[]>(env, `/zones?account.id=${env.CF_ACCOUNT_ID}&per_page=50`),
    cfFetch<CfTunnel[]>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=50`),
    cfFetch<CfWorkerDomain[]>(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`),
    cfFetch<CfDevice[]>(env, `/accounts/${env.CF_ACCOUNT_ID}/devices?per_page=100`),
  ]);

  const zones = zonesRes.result ?? [];
  const tunnels = tunnelsRes.result ?? [];
  const workerDomains = workerDomainsRes.result ?? [];
  const devices = devicesRes.result ?? [];

  const workerHostSet = new Set(workerDomains.map((d) => d.hostname));

  // hostname -> { tunnelId, service }
  const tunnelHostMap = new Map<string, { tunnelId: string; service: string }>();

  await Promise.all(
    tunnels.map(async (t) => {
      const cfg = await cfFetch<{ config: { ingress?: CfTunnelIngress[] } | null }>(
        env,
        `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${t.id}/configurations`
      );
      const ingress = cfg.result?.config?.ingress ?? [];
      for (const rule of ingress) {
        if (rule.hostname) {
          tunnelHostMap.set(rule.hostname, { tunnelId: t.id, service: rule.service });
        }
      }
    })
  );

  const zoneFleets = await Promise.all(
    zones.map(async (zone) => {
      const dnsRes = await cfFetch<CfDnsRecord[]>(env, `/zones/${zone.id}/dns_records?per_page=100`);
      const records = (dnsRes.result ?? []).filter(
        (r) => ["A", "AAAA", "CNAME"].includes(r.type) && !r.name.split(".")[0].startsWith("_")
      );

      // group records by hostname
      const byName = new Map<string, CfDnsRecord[]>();
      for (const r of records) {
        const list = byName.get(r.name) ?? [];
        list.push(r);
        byName.set(r.name, list);
      }

      type Classified = { hostname: string; group: HostGroupKey; purpose: string; target: string };
      const classified: Classified[] = [];

      for (const [hostname, recs] of byName) {
        if (workerHostSet.has(hostname)) {
          const label = hostname.split(".")[0];
          const purpose = hostname === zone.name ? "Apex" : label === "www" ? "Site" : titleCase(label);
          const service = workerDomains.find((d) => d.hostname === hostname)?.service ?? "worker";
          classified.push({ hostname, group: "worker", purpose, target: service });
          continue;
        }

        const tunnelCname = recs.find((r) => r.type === "CNAME" && r.content.endsWith(".cfargotunnel.com"));
        if (tunnelCname) {
          const tunnelId = tunnelCname.content.replace(".cfargotunnel.com", "");
          const info = tunnelHostMap.get(hostname);
          const purpose = info ? tunnelPurpose(info.service) : "Tunnel route";
          classified.push({ hostname, group: "tunnel", purpose, target: shortId(tunnelId) });
          continue;
        }

        const proxied = recs.some((r) => r.proxied);
        const target = recs.find((r) => r.content !== "100::")?.content ?? recs[0]?.content ?? "-";
        classified.push({
          hostname,
          group: "direct",
          purpose: proxied ? "Proxied" : "DNS only",
          target,
        });
      }

      const probes = await Promise.all(classified.map((c) => probeHost(c.hostname)));

      const stats: Record<HostStatus, number> = { online: 0, gated: 0, degraded: 0, offline: 0 };
      const groupMap = new Map<HostGroupKey, HostCard[]>();

      classified.forEach((c, i) => {
        const p = probes[i];
        stats[p.status]++;
        const card: HostCard = {
          hostname: c.hostname,
          purpose: c.purpose,
          target: c.target,
          link: `https://${c.hostname}`,
          status: p.status,
          code_label: p.code_label,
          note: p.note,
        };
        const list = groupMap.get(c.group) ?? [];
        list.push(card);
        groupMap.set(c.group, list);
      });

      const groups: HostGroup[] = (["tunnel", "direct", "worker"] as HostGroupKey[])
        .filter((k) => groupMap.has(k))
        .map((k) => ({ key: k, title: GROUP_META[k].title, note: GROUP_META[k].note, hosts: groupMap.get(k)! }));

      return {
        name: zone.name,
        cf_status: zone.paused ? "paused" : zone.status,
        groups,
        stats,
        dashboard_url: `https://dash.cloudflare.com/${env.CF_ACCOUNT_ID}/${zone.name}`,
      } satisfies ZoneFleet;
    })
  );

  const DEVICE_STALE_MS = 30 * 60 * 1000;
  const deviceCards = devices.map((d) => {
    const lastSeenMs = d.last_seen ? Date.parse(d.last_seen) : null;
    const connected = lastSeenMs !== null && Date.now() - lastSeenMs < DEVICE_STALE_MS;
    return {
      id: d.id,
      name: d.name,
      user_email: d.user?.email ?? null,
      device_type: d.device_type ?? null,
      last_seen: d.last_seen ?? null,
      connected,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    zones: zoneFleets,
    devices: deviceCards,
    devices_dashboard_url: `https://one.dash.cloudflare.com/${env.CF_ACCOUNT_ID}/my-team/devices`,
  };
}
