function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function timeAgo(iso) {
  if (!iso) return "never run";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0 || Number.isNaN(ms)) return "unknown";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  return `${Math.floor(d / 30)} mo ago`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATE_LABEL = {
  success: "PASSING",
  failure: "FAILING",
  running: "RUNNING",
  warn: "NEEDS ACTION",
  neutral: "NO VERDICT",
  none: "NEVER RUN",
};

const FILTERS = [
  { key: "all", label: "all", match: () => true },
  { key: "failure", label: "failing", match: (w) => w.state === "failure" || w.state === "warn" },
  { key: "running", label: "running", match: (w) => w.state === "running" },
  { key: "success", label: "passing", match: (w) => w.state === "success" },
  { key: "none", label: "never run", match: (w) => w.state === "none" || w.state === "neutral" },
];

let fleet = null;
let activeFilter = "all";
let query = "";

function historyStrip(history) {
  if (!history.length) return "";
  // Newest on the right, the way GitHub reads.
  const blocks = history
    .slice()
    .reverse()
    .map((r) => `<span class="run-block" data-state="${r.state}" title="#${r.number} · ${esc(r.result)} · ${esc(timeAgo(r.started_at))}"></span>`)
    .join("");
  return `<div class="run-strip">${blocks}</div>`;
}

function workflowCard(wf) {
  const run = wf.latest;
  const meta = run
    ? `<span class="tel-target">${esc(run.branch)} · ${esc(run.event)}</span><span>${esc(run.result)}${run.duration_ms !== null ? " · " + duration(run.duration_ms) : ""}</span>`
    : `<span class="tel-target">${esc(wf.path)}</span><span>no runs yet</span>`;

  const note = run
    ? `#${run.number} ${esc(run.title)}`
    : "This workflow has never been triggered.";

  return `
    <a class="card" data-status="${wf.state}" href="${esc(run ? run.url : wf.url)}" target="_blank" rel="noopener noreferrer">
      <div class="card-row">
        <div>
          <div class="host">${esc(wf.name)}</div>
          <div class="purpose">${esc(wf.path)}${wf.disabled ? " · disabled" : ""}</div>
        </div>
        <span class="status-tag mono"><span class="ping-dot"></span>${STATE_LABEL[wf.state]}</span>
      </div>
      <div class="tel-row mono">${meta}</div>
      ${historyStrip(wf.history)}
      <div class="tel-note">${note}</div>
      <div class="card-go mono">${run ? `${esc(timeAgo(run.started_at))} · open run` : "open workflow"} &#8599;</div>
    </a>`;
}

function repoSection(repo, workflows) {
  return `
    <section class="group">
      <div class="group-head">
        <h2><a class="repo-link" href="${esc(repo.actions_url)}" target="_blank" rel="noopener">${esc(repo.full_name)}</a></h2>
        <div class="note">
          <span class="repo-state" data-status="${repo.state}">${STATE_LABEL[repo.state]}</span>
          · ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}
          ${repo.private ? "· private" : ""}
          · pushed ${esc(timeAgo(repo.pushed_at))}
        </div>
      </div>
      <div class="cards">${workflows.map(workflowCard).join("")}</div>
    </section>`;
}

function render() {
  const data = fleet;
  if (!data) return;

  const t = data.totals;
  document.getElementById("summary").innerHTML = `
    <div class="stat success"><div class="n mono">${t.success}</div><div class="l">Passing</div></div>
    <div class="stat failure"><div class="n mono">${t.failure + t.warn}</div><div class="l">Failing</div></div>
    <div class="stat running"><div class="n mono">${t.running}</div><div class="l">Running</div></div>
    <div class="stat idle"><div class="n mono">${t.neutral + t.none}</div><div class="l">Idle / never run</div></div>`;

  document.getElementById("subline").textContent =
    `${data.workflow_count} workflow${data.workflow_count === 1 ? "" : "s"} across ${data.repos_with_workflows} of ${data.scanned_repos} repos scanned, read from GitHub ${new Date(data.generated_at).toLocaleTimeString()}.`;

  document.getElementById("tabbar").innerHTML = FILTERS.map((f) => {
    const count = f.key === "all"
      ? data.workflow_count
      : data.repos.reduce((n, r) => n + r.workflows.filter(f.match).length, 0);
    const active = f.key === activeFilter;
    return `<button class="tab ${active ? "active" : ""}" role="tab" aria-selected="${active}" data-key="${f.key}">${f.label} <span class="tab-count">${count}</span></button>`;
  }).join("");

  const filter = FILTERS.find((f) => f.key === activeFilter) ?? FILTERS[0];
  const q = query.trim().toLowerCase();

  const sections = data.repos
    .map((repo) => {
      const repoHit = repo.full_name.toLowerCase().includes(q);
      const workflows = repo.workflows.filter(
        (w) => filter.match(w) && (!q || repoHit || w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
      );
      return workflows.length ? repoSection(repo, workflows) : "";
    })
    .filter(Boolean);

  document.getElementById("repos").innerHTML = sections.length
    ? sections.join("")
    : `<div class="empty-state">${data.workflow_count
        ? "No workflows match this filter."
        : `No workflows found in the ${data.scanned_repos} repos scanned. Add a file under <code>.github/workflows/</code> and it shows up here.`}</div>`;

  document.getElementById("scan-note").textContent =
    `scanned ${data.scanned_repos} repos (personal + org), newest push first${data.truncated ? ` (${data.truncated} more not scanned)` : ""}`;

  document.getElementById("rate-note").textContent = data.rate
    ? `github api: ${data.rate.remaining}/${data.rate.limit} left, resets ${new Date(data.rate.reset * 1000).toLocaleTimeString()}`
    : "";

  document.querySelectorAll("#tabbar .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeFilter = tab.dataset.key;
      render();
    });
  });
}

async function refresh() {
  const btn = document.getElementById("refresh-btn");
  btn.textContent = "[ ⟳ scanning… ]";
  btn.disabled = true;
  try {
    const res = await fetch("/api/actions", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `API ${res.status}`);
    fleet = data;
    render();
  } catch (e) {
    document.getElementById("subline").textContent = `Couldn't read GitHub: ${e.message}`;
    if (!fleet) {
      document.getElementById("repos").innerHTML =
        `<div class="empty-state">${esc(e.message)}</div>`;
    }
  } finally {
    btn.textContent = "[ ⟳ rescan ]";
    btn.disabled = false;
  }
}

function tickClock() {
  const el = document.getElementById("clock");
  if (el) el.textContent = new Date().toLocaleTimeString("en-GB");
}

document.getElementById("refresh-btn").addEventListener("click", refresh);
document.getElementById("search").addEventListener("input", (e) => {
  query = e.target.value;
  render();
});
tickClock();
setInterval(tickClock, 1000);
refresh();
// Slower than the fleet page: a workflow run is minutes of work, and every
// scan costs a slice of the hourly GitHub rate limit.
setInterval(refresh, 180000);
