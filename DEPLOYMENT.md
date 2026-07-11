# Deployment

GameDash deploys **two** containers to the VPS on every push to `main`, both fully
server-side (GitHub Actions + repo secrets — no local machine involved):

1. **`gamedash-web`** — the Vite SPA served by nginx (loopback `127.0.0.1:3002`).
2. **`gamedash-realtime`** — the multiplayer room server (loopback `127.0.0.1:3003`,
   in-container port `8090`). Added in multiplayer Phase 6.

Live: https://gamedash.workdash.site · realtime endpoint `wss://gamedash.workdash.site/realtime`.

## Pipeline

`.github/workflows/deploy.yml` runs on `push` to `main` (and `workflow_dispatch`):

1. **build** — in one job:
   - reads `PROTOCOL_VERSION` from `packages/shared/src/net/constants.ts` (stamped onto the
     realtime image tags/labels);
   - builds the **web** image (root `Dockerfile`: Vite `dist` → nginx) with the
     `VITE_REALTIME_URL=wss://gamedash.workdash.site/realtime` build arg, pushing
     `ghcr.io/ainderew/gamedash:latest` (+ `:${sha}`);
   - builds the **realtime** image (`apps/realtime/Dockerfile`: esbuild bundle → `node:22-alpine`,
     non-root), pushing `ghcr.io/ainderew/gamedash-realtime:latest` (+ `:${sha}` + `:proto-N`).
   - Both use scoped GHA layer caches.
2. **deploy** — SSHes into the droplet and, for each service:
   - `docker login ghcr.io` with `GHCR_PAT`, `docker pull …:latest`;
   - web: stop/rm/run `gamedash-web` on `127.0.0.1:3002:80`;
   - realtime: `docker stop -t 15 gamedash-realtime` (SIGTERM → the server notifies live
     sessions "server restarting" and drains within its 10 s grace), then run
     `gamedash-realtime` on `127.0.0.1:3003:8090` with `MAX_SESSIONS` / `IDLE_SESSION_TIMEOUT_MS`.

The host nginx vhost (`deploy/gamedash.nginx.conf`) proxies `gamedash.workdash.site` →
`127.0.0.1:3002` for the SPA, and `location /realtime` upgrades WebSocket traffic to
`127.0.0.1:3003` (`proxy_http_version 1.1`, Upgrade/Connection headers, `proxy_buffering off`,
120 s read timeout). Same origin as the SPA ⇒ no CORS. certbot handles TLS for both.

### One-time host setup for the realtime service

The nginx vhost + certbot already terminate TLS for the domain. Adding the realtime location is a
config edit (already in `deploy/gamedash.nginx.conf`), then `nginx -t && systemctl reload nginx`.
No new DNS, ports, or certs — realtime rides the existing `gamedash.workdash.site` cert on 443 and
is only reachable through nginx (the container binds loopback only). First rollout can also be done
by hand on the droplet with `docker compose -f docker-compose.vps.yml up -d --build`.

### Monitoring

`curl -s localhost:3003/metrics | jq` on the droplet shows sessions, players, snapshot bytes/s,
event-queue depth, and tick p50/p99 (KPI: p99 < 15 ms). `/healthz` is the container healthcheck.

## Required repo secrets

Set on `ainderew/GameDash` (Settings → Secrets and variables → Actions). These
are what the deploy job needs — the pipeline fails without them:

| Secret | What it is |
| --- | --- |
| `DROPLET_IP` | VPS IP, `194.233.79.158` |
| `SSH_PRIVATE_KEY` | **Passphrase-less** CI deploy key (`~/.ssh/gamedash_deploy` locally). Its public half is in the droplet's `root` `authorized_keys`. Do **not** use a passphrase-protected key — `appleboy/ssh-action` can't unlock it. |
| `GHCR_PAT` | Classic PAT with `read:packages`, so the droplet can pull the private image. |

Only the `ainderew` GitHub account (repo owner) can write these secrets.

## Deploying from any machine

Deployment is fully server-side (GitHub Actions + repo secrets). Any push to
`main` — from any computer — triggers it. The workflow does **not** use your
local machine, SSH keys, or `gh` login.

The only requirement on another PC is **git push access to `main`**:

- Remote: `git@github.com:ainderew/GameDash.git` (private).
- Push must authenticate as the `ainderew` GitHub account. This repo pins
  `core.sshCommand = ssh -F /dev/null -i ~/.ssh/ainderew -o IdentitiesOnly=yes`
  because the default `~/.ssh/config` forces the `work` key (account `ddrew98`,
  which has **no** write access).
- On a new machine: copy the `ainderew` SSH key (or use any credential with
  write access to the repo), then either re-pin `core.sshCommand` or add the key
  to your SSH config. Once you can `git push`, deploys happen automatically.

## Manual controls

```bash
# trigger a deploy without a code change
gh workflow run deploy.yml --repo ainderew/GameDash

# re-run the last run's failed jobs
gh run rerun <run-id> --failed --repo ainderew/GameDash

# watch a run
gh run watch <run-id> --repo ainderew/GameDash
```

## Revoking CI access

Remove the `gamedash-ci-deploy` line from
`root@194.233.79.158:~/.ssh/authorized_keys` and delete the `SSH_PRIVATE_KEY`
secret.

## Backend

`apps/server` is not deployed — it has no routes yet and the frontend makes no
backend calls. Deploy it only once it has real endpoints.
