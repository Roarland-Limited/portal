# Cloudflare Fleet Status Portal

A live status console for a personal Cloudflare account — every domain, every DNS host behind it (tunnels, direct records, Workers), and enrolled WARP devices, in one page. Deployed at [portal.roarland.net](https://portal.roarland.net).

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

## Project layout

```
src/
  index.ts        Hono app, single /api/fleet route
  cloudflare.ts    Cloudflare API client + host classification + HTTP probing
public/
  index.html       Static shell
  app.js           Fetches /api/fleet, renders tabs/cards, client-side only
  style.css        Signal-console theme (dark, monospace-forward)
wrangler.toml      Worker config, static assets binding, portal.roarland.net route
```

## Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in CF_API_TOKEN
npm run dev
```

Requires a Cloudflare API token with `Zone:Read`, `DNS:Read`, `Account:Cloudflare Tunnel:Read`, `Account:Zero Trust:Read`, and `Account:Workers Scripts:Edit` (the last one only needed for deploys).

## Deploy

```
npm run deploy
```

The `CF_API_TOKEN` secret is set once via `wrangler secret put CF_API_TOKEN` and persists across deploys — it is never committed to this repo.

If this repo is connected to Cloudflare's Git integration (Workers Builds), every push to `main` deploys automatically and `npm run deploy` is no longer needed locally.
