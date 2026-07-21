function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function timeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0 || Number.isNaN(ms)) return "unknown";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function latWidth(host) {
  if (host.status === "offline") return 100;
  const ms = /^\d+ ms$/.test(host.note) ? parseInt(host.note, 10) : 60;
  return Math.max(4, Math.min(100, Math.round(ms / 30)));
}

const STATUS_LABEL = { online: "ONLINE", gated: "GATED", degraded: "DEGRADED", offline: "OFFLINE" };

function hostCard(h) {
  const actionLabel = h.purpose && h.purpose.toLowerCase().includes("ssh") ? "open terminal" : "open site";
  return `
    <a class="card" data-status="${h.status}" href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">
      <div class="card-row">
        <div>
          <div class="host">${esc(h.hostname)}</div>
          <div class="purpose">${esc(h.purpose)}</div>
        </div>
        <span class="status-tag mono"><span class="ping-dot"></span>${STATUS_LABEL[h.status]}</span>
      </div>
      <div class="tel-row mono"><span class="tel-target">${esc(h.target)}</span><span>${esc(h.code_label)}</span></div>
      <div class="tel-track"><div class="tel-fill" style="width:${latWidth(h)}%"></div></div>
      <div class="tel-note ${/^\d+ ms$/.test(h.note) ? "mono" : ""}">${esc(h.note)}</div>
      <div class="card-go mono">${actionLabel} &#8599;</div>
    </a>`;
}

function zonePanel(zone, index) {
  const groupsHtml = zone.groups.length
    ? zone.groups.map((g) => `
      <section class="group">
        <div class="group-head">
          <h2>${esc(g.title)}</h2>
          <div class="note">${esc(g.note)}</div>
        </div>
        <div class="cards">${g.hosts.map(hostCard).join("")}</div>
      </section>`).join("")
    : `<div class="empty-state">Nothing on record for this zone yet.</div>`;

  const total = zone.stats.online + zone.stats.gated + zone.stats.degraded + zone.stats.offline;

  return `
    <div class="tabpanel" id="panel-${index}" role="tabpanel" aria-labelledby="tab-${index}" ${index === 0 ? "" : "hidden"}>
      <div class="summary-row">
        <div class="stat online"><div class="n mono">${zone.stats.online}</div><div class="l">Online</div></div>
        <div class="stat gated"><div class="n mono">${zone.stats.gated}</div><div class="l">Gated (Access)</div></div>
        <div class="stat degraded"><div class="n mono">${zone.stats.degraded}</div><div class="l">Degraded</div></div>
        <div class="stat offline"><div class="n mono">${zone.stats.offline}</div><div class="l">Offline</div></div>
      </div>
      ${groupsHtml}
      <footer class="foot mono">
        <span>${total} host${total === 1 ? "" : "s"} tracked · cf status: ${esc(zone.cf_status)}</span>
        <span><a href="${esc(zone.dashboard_url)}" target="_blank" rel="noopener">open in cloudflare dash &#8599;</a></span>
      </footer>
    </div>`;
}

function deviceCard(d, dashboardUrl) {
  const status = d.connected ? "online" : "offline";
  return `
    <a class="card" data-status="${status}" href="${esc(dashboardUrl)}" target="_blank" rel="noopener noreferrer">
      <div class="card-row">
        <div>
          <div class="host">${esc(d.name || "unnamed device")}</div>
          <div class="purpose">${esc(d.user_email || "-")}</div>
        </div>
        <span class="status-tag mono"><span class="ping-dot"></span>${STATUS_LABEL[status]}</span>
      </div>
      <div class="tel-row mono"><span class="tel-target">${esc(d.device_type || "-")}</span><span>${esc(timeAgo(d.last_seen))}</span></div>
    </a>`;
}

function render(data) {
  const tabbar = document.getElementById("tabbar");
  const panels = document.getElementById("panels");

  document.getElementById("subline").textContent =
    `Pulled from Cloudflare's API just now, then probed live over HTTPS — ${data.zones.length} zone${data.zones.length === 1 ? "" : "s"}, refreshed ${new Date(data.generated_at).toLocaleTimeString()}.`;

  tabbar.innerHTML = data.zones.map((z, i) => `
    <button class="tab ${i === 0 ? "active" : ""}" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-index="${i}" id="tab-${i}" aria-controls="panel-${i}">${esc(z.name)}</button>
  `).join("");

  panels.innerHTML = data.zones.map((z, i) => zonePanel(z, i)).join("");

  const devicesGrid = document.getElementById("devices-grid");
  document.getElementById("devices-note").textContent = `${data.devices.length} enrolled`;
  devicesGrid.innerHTML = data.devices.length
    ? data.devices.map((d) => deviceCard(d, data.devices_dashboard_url)).join("")
    : `<div class="empty-state">No WARP devices enrolled. <a href="${esc(data.devices_dashboard_url)}" target="_blank" rel="noopener">Add one in Zero Trust</a> and it'll show up here.</div>`;

  const tabs = Array.prototype.slice.call(tabbar.querySelectorAll(".tab"));
  const tabPanels = Array.prototype.slice.call(panels.querySelectorAll(".tabpanel"));

  function activate(tab) {
    tabs.forEach((t) => {
      const isActive = t === tab;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
      t.tabIndex = isActive ? 0 : -1;
    });
    tabPanels.forEach((p) => {
      p.hidden = p.id !== "panel-" + tab.dataset.index;
    });
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = tabs[(i + 1) % tabs.length];
        next.focus();
        activate(next);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = tabs[(i - 1 + tabs.length) % tabs.length];
        prev.focus();
        activate(prev);
      }
    });
  });
}

async function load() {
  const res = await fetch("/api/fleet", { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function refresh() {
  const btn = document.getElementById("refresh-btn");
  btn.textContent = "[ ⟳ probing… ]";
  btn.disabled = true;
  try {
    const data = await load();
    render(data);
  } catch (e) {
    document.getElementById("subline").textContent = `Couldn't reach the API: ${e.message}`;
  } finally {
    btn.textContent = "[ ⟳ refresh ]";
    btn.disabled = false;
  }
}

function tickClock() {
  const el = document.getElementById("clock");
  if (el) el.textContent = new Date().toLocaleTimeString("en-GB");
}

document.getElementById("refresh-btn").addEventListener("click", refresh);
tickClock();
setInterval(tickClock, 1000);
refresh();
setInterval(refresh, 60000);
