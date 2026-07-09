# Deployment

The GameDash **frontend** auto-deploys to the VPS on every push to `main`.
No manual steps — GitHub Actions builds the image, pushes it to GHCR, and the
droplet pulls and runs it.

Live: https://gamedash.workdash.site

## Pipeline

`.github/workflows/deploy.yml` runs on `push` to `main` (and `workflow_dispatch`):

1. **build** — builds the Docker image (Vite `dist` → nginx) and pushes it to
   `ghcr.io/ainderew/gamedash:latest` (+ a `:${sha}` tag), using GHA layer cache.
2. **deploy** — SSHes into the droplet and:
   - `docker login ghcr.io` with `GHCR_PAT`
   - `docker pull ghcr.io/ainderew/gamedash:latest`
   - restarts the `gamedash-web` container bound to `127.0.0.1:3002`

The host nginx vhost (`deploy/gamedash.nginx.conf`) proxies
`gamedash.workdash.site` → `127.0.0.1:3002`; certbot handles TLS.

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
