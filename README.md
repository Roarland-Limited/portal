# Cloudflare Fleet Status Portal

A live status console for a personal Cloudflare account — every domain, every DNS host behind it (tunnels, direct records, Workers), and enrolled WARP devices, in one page. Deployed at [portal.roarland.net](https://portal.roarland.net).

Each zone gets its own tab. Every host card is a real link to the live service, colored by a combined signal: Cloudflare's own status plus a real HTTPS probe run at request time.

## How status is determined

For each zone, the Worker pulls DNS records, matches them against Cloudflare Tunnel configs and Workers custom domains, then classifies every hostname into one of three groups:

- **Cloudflare Tunnel** — CNAME target ends in `cfargotunnel.com`. Purpose (SSH / web service / port) is read straight from the tunnel's ingress rule.
- **Direct record** — plain A/AAAA/CNAME, proxied or DNS-only.
- **Cloudflare Workers** — hostname is a registered Workers custom domain.

Each host is then probed live over HTTPS (6s timeout, following redirects):

| Status | Meaning |
|---|---|
| `online` | Response status < 500 |
| `gated` | Redirected to a `cloudflareaccess.com` login — Zero Trust Access is working as intended |
| `degraded` | Response status ≥ 500 (origin/tunnel reachable, something behind it is erroring) |
| `offline` | Request timed out or the connection failed outright |

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
