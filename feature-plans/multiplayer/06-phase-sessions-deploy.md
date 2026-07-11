# Phase 6 — Session UX, Zone Flow, Reconnect, Deployment

> **Goal:** the whole loop is usable by non-developers on the live site: create/join a party from the menu, gate into the expedition together, survive a dropped connection, return to the hub — with the realtime server deployed, secured, and observable on the existing VPS.
>
> **Depends on:** Phase 2 (UX tasks can start then); deployment tasks close after 4–5.

## Tasks

### Task 1: Multiplayer menu + party UX
- Replace the Phase 2 dev-grade UI in `apps/web/src/ui/MainMenu.tsx`: **Play Together** flow — Create Party (big shareable 6-char code + copy button) / Join Party (code entry, friendly errors: not found / full / version mismatch) / character select honoring `playerCharacter` per member.
- Party HUD widget: member names (user-entered, profanity-filtered, stored with the guest identity), HP bars for teammates, carrier icon (who has the relic), integrating the Phase 2 `PingCard.tsx` per-member live ping (DOM/Tailwind, never three.js — see Phase 2 Task 6 spec). Follow existing Tailwind HUD conventions.
- Solo remains the default one-click path; multiplayer is opt-in.

### Task 2: Zone transition flow (party gate)
- Server-coordinated (per the Open Question default): any member at the Expedition Gate presses E → server starts a 5 s countdown broadcast (`ZoneCountdown`), any member can cancel; on zero the server flips the session zone, teleports all players (`SocialHub.tsx:443-461` logic moves server-side), clients play the existing gate transition.
- **Return path (new — solo lacks it too):** hunt end (fail or a future "extract") → server returns the party to the hub, resets expedition world state. Fix the solo return path with the same code (`huntFailed` overlay gets a "Return to Hub" that works in both modes).
- Late-zone-join: a member connecting/reconnecting while the party is in expedition spawns them at the expedition entrance, not the hub.

### Task 3: Reconnect + resilience
- `resumeToken` (Phase 2) → 30 s grace: entity persists (downed-like "link-dead" visual), inputs starve to idle; reconnect within grace resumes seamlessly (welcome keyframe snapshot); past grace → treated as leave (relic drop rule from Phase 5, entity removed).
- Client: transport auto-reconnect with backoff + session resume; "Reconnecting…" overlay; graceful fall-out to menu with a rejoin-by-code hint after grace expiry.
- Server hardening: per-connection rate limits (msgs/s, bytes/s), input sanity clamps audit, session cap (env `MAX_SESSIONS`), idle session GC, panic-safe room isolation (one room's exception can't kill the process — try/catch per room tick, poisoned room torn down with notice to its clients).

### Task 4: Deployment
- **Docker:** `apps/realtime/Dockerfile` (multi-stage pnpm → `node:22-alpine`, non-root). New service in `docker-compose.vps.yml`: `gamedash-realtime`, loopback `127.0.0.1:3003:8090`, healthcheck `/healthz`, `restart: unless-stopped`.
- **nginx:** extend `deploy/gamedash.nginx.conf` — `location /realtime { proxy_pass http://127.0.0.1:3003; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 120s; }` (same origin as the SPA ⇒ no CORS, `wss://gamedash.workdash.site/realtime`).
- **CI:** extend `.github/workflows/deploy.yml` — build/push `ghcr.io/ainderew/gamedash-realtime:latest`, deploy step restarts both services; realtime deploys drain politely (SIGTERM → notify sessions "server restarting" → 10 s grace). Version-stamp the image with the protocol version; client shows "update available" on version mismatch instead of a cryptic error.
- Env plumbing: `VITE_REALTIME_URL` in the web build args.

### Task 5: Observability + soak
- Metrics endpoint (`/metrics` or structured logs): sessions, players, tick duration p50/p99 (KPI: p99 < 15 ms — half the 33 ms budget), snapshot bytes/s, event queue depth. Alert-worthy: tick overruns, room crashes.
- **Soak test:** bot fleet (Phase 3/4 bots) — 10 sessions × 4 bots fighting + relaying for 1 hour on the droplet: zero crashes, no memory growth, tick p99 within budget. Run before announcing to friends.
- Client analytics-lite: log reconciliation-correction rate + RTT distribution (console/debug only for now) to validate real-world smoothness beyond the simulated harness.

### Task 6: Docs
- `apps/realtime/README.md`: architecture recap, local dev (two tabs), protocol version bump procedure, deploy runbook. Update `DEPLOYMENT.md` (currently states only the frontend is deployed) and the friendslop `00-overview.md` decisions log (Decision #4 superseded, link here).

## Acceptance criteria
- A friend with only the URL and a code joins in < 30 s from the live site (real network, phones-on-hotspot test included).
- Mid-expedition Wi-Fi blip (≤ 30 s) → seamless resume; > 30 s → clean removal, relic recovered by the party.
- Deploy of a new realtime version mid-session: players get the restart notice, can rejoin immediately after.
- 1-hour soak green; nginx/TLS handshake works (wss) from Chrome, Firefox, Safari.

## Risks
- **Same-origin WSS through nginx buffering/timeouts** — explicitly disable proxy buffering for the location, set sane read timeouts (heartbeat keeps it alive); test with certbot renewal cycle.
- **Shared VPS contention** (other apps on the droplet): the tick-duration metric is the early-warning; if contended, a dedicated small droplet for realtime is a one-line compose move — the architecture doesn't care.
