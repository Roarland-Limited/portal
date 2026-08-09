import type { Env } from "./cloudflare";

const GH_API = "https://api.github.com";

// Every scan costs one subrequest per repo, plus one more for repos that
// actually have workflows. Cap it so a large account can't blow the Worker's
// subrequest budget or burn the hourly GitHub rate limit in a few refreshes.
const DEFAULT_REPO_LIMIT = 40;
const RUNS_PER_REPO = 50;
const HISTORY_PER_WORKFLOW = 7;

export interface RateInfo {
  remaining: number;
  limit: number;
  reset: number;
}

class GithubError extends Error {}

interface RateHolder {
  info: RateInfo | null;
}

async function ghFetch<T>(env: Env, path: string, rate: RateHolder): Promise<T | null> {
  if (!env.GITHUB_TOKEN) {
    throw new GithubError(
      "GITHUB_TOKEN is not set — add it as a Secret under Workers & Pages → cf-portal → Settings → Variables and Secrets"
    );
  }

  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects requests without one.
      "User-Agent": "roarland-portal",
    },
    signal: AbortSignal.timeout(10000),
  });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null) {
    rate.info = {
      remaining: Number(remaining),
      limit: Number(res.headers.get("x-ratelimit-limit") ?? 0),
      reset: Number(res.headers.get("x-ratelimit-reset") ?? 0),
    };
  }

  // A repo with Actions switched off answers 404 on the workflow endpoints.
  // That is an absence of data, not a failure — let the caller treat it as empty.
  if (res.status === 404) return null;

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body.message ? ` — ${body.message}` : "";
    } catch {
      /* body wasn't JSON */
    }
    if (res.status === 401) throw new GithubError(`GitHub rejected the token (401)${detail}`);
    if (res.status === 403 && rate.info?.remaining === 0) {
      throw new GithubError(`GitHub rate limit exhausted, resets at ${new Date(rate.info.reset * 1000).toISOString()}`);
    }
    throw new GithubError(`GitHub API ${res.status}${detail}`);
  }

  return (await res.json()) as T;
}

interface GhRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  default_branch: string;
}

interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
}

interface GhRun {
  id: number;
  workflow_id: number;
  run_number: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  html_url: string;
  display_title?: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login?: string };
  head_commit?: { message?: string } | null;
}

export type RunState = "success" | "failure" | "running" | "warn" | "neutral" | "none";

export interface RunCard {
  id: number;
  number: number;
  state: RunState;
  result: string;
  event: string;
  branch: string;
  actor: string;
  title: string;
  url: string;
  started_at: string;
  duration_ms: number | null;
}

export interface WorkflowCard {
  id: number;
  name: string;
  path: string;
  state: RunState;
  disabled: boolean;
  url: string;
  latest: RunCard | null;
  history: RunCard[];
}

export interface RepoCard {
  name: string;
  owner: string;
  full_name: string;
  url: string;
  private: boolean;
  pushed_at: string | null;
  actions_url: string;
  state: RunState;
  workflows: WorkflowCard[];
}

export interface OwnerSummary {
  login: string;
  repos: number;
  workflows: number;
  failing: number;
}

export interface GithubFleet {
  generated_at: string;
  repos: RepoCard[];
  owners: OwnerSummary[];
  totals: Record<RunState, number>;
  scanned_repos: number;
  repos_with_workflows: number;
  workflow_count: number;
  truncated: number;
  rate: RateInfo | null;
}

function runState(run: GhRun): RunState {
  // Anything that isn't "completed" — queued, in_progress, waiting,
  // requested, pending — is still moving, so it gets one bucket.
  if (run.status !== "completed") return "running";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    case "action_required":
      return "warn";
    default:
      // cancelled, skipped, neutral, stale — ran, but says nothing about health.
      return "neutral";
  }
}

function resultLabel(run: GhRun): string {
  if (run.status !== "completed") return (run.status ?? "queued").replace(/_/g, " ");
  return (run.conclusion ?? "unknown").replace(/_/g, " ");
}

function toRunCard(run: GhRun): RunCard {
  const started = run.run_started_at ?? run.created_at;
  const startedMs = Date.parse(started);
  const endedMs = Date.parse(run.updated_at);
  const completed = run.status === "completed";
  const duration =
    completed && !Number.isNaN(startedMs) && !Number.isNaN(endedMs) && endedMs >= startedMs ? endedMs - startedMs : null;

  const title = run.display_title || run.head_commit?.message?.split("\n")[0] || `Run #${run.run_number}`;

  return {
    id: run.id,
    number: run.run_number,
    state: runState(run),
    result: resultLabel(run),
    event: run.event,
    branch: run.head_branch ?? "-",
    actor: run.actor?.login ?? "-",
    title,
    url: run.html_url,
    started_at: started,
    duration_ms: duration,
  };
}

function emptyTotals(): Record<RunState, number> {
  return { success: 0, failure: 0, running: 0, warn: 0, neutral: 0, none: 0 };
}

export async function buildGithubFleet(env: Env): Promise<GithubFleet> {
  const rate: RateHolder = { info: null };
  const limit = Number(env.GITHUB_REPO_LIMIT ?? "") || DEFAULT_REPO_LIMIT;

  // organization_member pulls in org repos alongside personal ones. Sorted by
  // push date, so the 100 the API returns are always the 100 most recently
  // touched — the cap below trims from an already-relevant list.
  const allRepos =
    (await ghFetch<GhRepo[]>(
      env,
      `/user/repos?affiliation=owner,organization_member&sort=pushed&direction=desc&per_page=100`,
      rate
    )) ?? [];

  // Forks and archives carry inherited or frozen workflows that nobody is
  // going to act on; they'd only pad the board.
  const candidates = allRepos.filter((r) => !r.fork && !r.archived);
  const repos = candidates.slice(0, limit);

  const cards = await Promise.all(
    repos.map(async (repo): Promise<RepoCard | null> => {
      const wfRes = await ghFetch<{ workflows: GhWorkflow[] }>(
        env,
        `/repos/${repo.full_name}/actions/workflows?per_page=100`,
        rate
      );
      const workflows = (wfRes?.workflows ?? []).filter((w) => w.state !== "deleted");
      if (!workflows.length) return null;

      // One call covers every workflow in the repo — cheaper than asking per
      // workflow, and the runs come back newest-first already.
      const runsRes = await ghFetch<{ workflow_runs: GhRun[] }>(
        env,
        `/repos/${repo.full_name}/actions/runs?per_page=${RUNS_PER_REPO}`,
        rate
      );
      const runs = runsRes?.workflow_runs ?? [];

      const byWorkflow = new Map<number, GhRun[]>();
      for (const run of runs) {
        const list = byWorkflow.get(run.workflow_id) ?? [];
        if (list.length < HISTORY_PER_WORKFLOW) list.push(run);
        byWorkflow.set(run.workflow_id, list);
      }

      const workflowCards: WorkflowCard[] = workflows.map((w) => {
        const history = (byWorkflow.get(w.id) ?? []).map(toRunCard);
        const latest = history[0] ?? null;
        return {
          id: w.id,
          name: w.name,
          path: w.path,
          state: latest ? latest.state : "none",
          disabled: w.state !== "active",
          url: w.html_url,
          latest,
          history,
        };
      });

      workflowCards.sort((a, b) => {
        const at = a.latest ? Date.parse(a.latest.started_at) : 0;
        const bt = b.latest ? Date.parse(b.latest.started_at) : 0;
        return bt - at;
      });

      // A repo is only as green as its worst workflow.
      const order: RunState[] = ["failure", "warn", "running", "success", "neutral", "none"];
      const repoState = order.find((s) => workflowCards.some((w) => w.state === s)) ?? "none";

      return {
        name: repo.name,
        owner: repo.full_name.split("/")[0],
        full_name: repo.full_name,
        url: repo.html_url,
        private: repo.private,
        pushed_at: repo.pushed_at,
        actions_url: `${repo.html_url}/actions`,
        state: repoState,
        workflows: workflowCards,
      };
    })
  );

  const repoCards = cards.filter((c): c is RepoCard => c !== null);

  // Broken repos first — you open this page to find what needs attention.
  const rank: Record<RunState, number> = { failure: 0, warn: 1, running: 2, success: 3, neutral: 4, none: 5 };
  repoCards.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return Date.parse(b.pushed_at ?? "") - Date.parse(a.pushed_at ?? "");
  });

  const totals = emptyTotals();
  let workflowCount = 0;
  for (const repo of repoCards) {
    for (const w of repo.workflows) {
      totals[w.state]++;
      workflowCount++;
    }
  }

  // One entry per account or org, so the page can be filtered down to the one
  // you're actually responsible for right now.
  const ownerMap = new Map<string, OwnerSummary>();
  for (const repo of repoCards) {
    const entry = ownerMap.get(repo.owner) ?? { login: repo.owner, repos: 0, workflows: 0, failing: 0 };
    entry.repos++;
    entry.workflows += repo.workflows.length;
    entry.failing += repo.workflows.filter((w) => w.state === "failure" || w.state === "warn").length;
    ownerMap.set(repo.owner, entry);
  }
  const owners = [...ownerMap.values()].sort(
    (a, b) => b.failing - a.failing || b.workflows - a.workflows || a.login.localeCompare(b.login)
  );

  return {
    generated_at: new Date().toISOString(),
    repos: repoCards,
    owners,
    totals,
    scanned_repos: repos.length,
    repos_with_workflows: repoCards.length,
    workflow_count: workflowCount,
    truncated: Math.max(0, candidates.length - repos.length),
    rate: rate.info,
  };
}
