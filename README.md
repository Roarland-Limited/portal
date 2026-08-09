# Cloudflare Fleet Status Portal

A live status console for a personal Cloudflare account — every domain, every DNS host behind it (tunnels, direct records, Workers), and enrolled WARP devices, in one page. Deployed at [portal.roarland.ai](https://portal.roarland.ai).

Each zone gets its own tab. Every host card is a real link to the live service, colored by a combined signal: Cloudflare's own status plus a real HTTPS probe run at request time.

## How status is determined

For each zone, the Worker pulls DNS records, matches them against Cloudflare Tunnel configs and Workers custom domains, then classifies every hostname into one of three groups:

- **Cloudflare Tunnel** — CNAME target ends in `cfargotunnel.com`. Purpose (SSH / web service / port) is read straight from the tunnel's ingress rule.
- **Direct record** — plain A/AAAA/CNAME, proxied or DNS-only.
- **Cloudflare Workers** — hostname is a registered Workers custom domain.

Each host is then probed live over HTTPS (12s timeout, following redirects):

| Status | Meaning |
|---|---|
| `online` | Response status < 500. Anything slower than 4s is still online, but the card says so |
| `gated` | Redirected to a `cloudflareaccess.com` login — Zero Trust Access is working as intended |
| `degraded` | Response status ≥ 500 (origin/tunnel reachable, something behind it is erroring) |
| `offline` | Request timed out or the connection failed outright |

The 12s deadline is deliberate. It started at 6s, which landed right on top of an
uncached WordPress render (`shop.roarland.ai` measured 5.7–9.1s cold, and 33s under six
concurrent cold hits), so roughly every other scan called a healthy site offline and the
next one called it recovered. Slow is not down.

## Offline alerts

The cron trigger runs the same scan every 3 hours and mails via Resend on transitions
only — a host that stays offline is not re-reported.

Before anything is mailed, every host the scan called offline is re-probed on its own:
up to 2 more attempts, 3s apart, with a 25s deadline. The scan probes all hosts
concurrently, so a slow origin can miss its deadline partly because of the pile-up the
scan itself created; the confirmation probes run alone and sequentially, which removes
that. Only a host that fails every attempt gets mailed, and one that comes back is
recorded as online so it can't produce a phantom "recovered" mail later.

If more than 3 hosts are down at once, confirmation is skipped and the mail goes out
immediately — that many at once is a tunnel or a box, not a flaky probe. It's also what
bounds how long the check can run.

`GET /api/check-alerts` runs the whole thing on demand and returns what it found,
including a `falseAlarms` list naming hosts the confirmation step rescued.

## GitHub Actions board (`/actions`)

A second page scans your own GitHub repos and lists what every workflow last did.

The scan walks `/user/repos?affiliation=owner`, newest push first, skipping forks and
archived repos (inherited or frozen workflows nobody will act on). For each repo it
asks for the workflow definitions; repos with none drop out. Repos that have workflows
get a single `/actions/runs` call — one request covers every workflow in the repo — and
the runs are grouped per workflow to give the latest result plus the last 7 as a strip.

| State | Meaning |
|---|---|
| `PASSING` | Latest run completed with `success` |
| `FAILING` | Latest run was `failure`, `timed_out`, or `startup_failure` |
| `NEEDS ACTION` | Latest run is waiting on `action_required` |
| `RUNNING` | Latest run is queued, in progress, or waiting |
| `NO VERDICT` | Latest run was cancelled, skipped, neutral, or stale |
| `NEVER RUN` | Workflow file exists but has never been triggered |

Repos sort worst-first, and each repo takes the state of its unhealthiest workflow.
Filter tabs narrow to failing / running / passing / never-run; the search box filters
by repo or workflow name. Scans are capped at 40 repos (`GITHUB_REPO_LIMIT` overrides)
so one refresh can't exhaust the Worker's subrequest budget or the hourly GitHub rate
limit — the remaining quota is printed in the page footer.

## Project layout

```
src/
  index.ts         Hono app: /api/fleet, /api/actions, /api/check-alerts
  cloudflare.ts    Cloudflare API client + host classification + HTTP probing
  github.ts        GitHub API client + repo scan + workflow run grouping
  alerting.ts      Offline detection + Resend email, driven by the cron trigger
public/
  index.html       Fleet status shell
  app.js           Fetches /api/fleet, renders tabs/cards, client-side only
  actions.html     GitHub Actions shell (served at /actions)
  actions.js       Fetches /api/actions, renders filters + workflow cards
  style.css        Signal-console theme (dark, monospace-forward), shared
wrangler.toml      Worker config, static assets binding, portal.roarland.ai route
```

## Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in the three tokens
npm run dev
```

`.dev.vars` is local only — it is gitignored, and `wrangler dev` reads it instead of the
deployed secrets. The deployed Worker never sees this file.

## Secrets

All three secrets live in the Cloudflare dashboard, not in this repo and not in
`wrangler.toml`:

**Workers & Pages → cf-portal → Settings → Variables and Secrets → Add**, type
**Secret**, then Deploy.

| Secret | What it needs |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token: `Zone:Read`, `DNS:Read`, `Account:Cloudflare Tunnel:Read`, `Account:Zero Trust:Read` |
| `RESEND_API_KEY` | Resend API key, for the offline alert emails |
| `GITHUB_TOKEN` | GitHub PAT for the `/actions` page. Fine-grained: **Actions: read-only** + **Metadata: read-only** on the repos to list. Classic: `repo`, or `public_repo` if nothing private should appear |

Secrets set in the dashboard survive every deploy — `wrangler deploy` and Workers Builds
both leave them alone. Editing a secret's value takes effect on save, no redeploy needed.

## Deploy

```
npm run deploy
```

If this repo is connected to Cloudflare's Git integration (Workers Builds), every push to `main` deploys automatically and `npm run deploy` is no longer needed locally.
