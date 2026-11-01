# Automatic deploy to cPanel

After a push to `main`, GitHub runs the tests (CI). When they pass, the
**Deploy to cPanel** workflow updates the live site by itself:

1. cPanel pulls `main` into the cPanel repository `~/aqdi-src`
   (UAPI `VersionControl/update`).
2. cPanel runs `.cpanel.yml` (UAPI `VersionControlDeployment/create`), which
   runs `deploy/cpanel-deploy.sh`:
   - copies the app files to `~/aqdi` (never `.env`, uploads, backups or
     `node_modules`; nothing on the server is deleted),
   - runs `npm install --omit=dev` in the cPanel Node.js environment,
   - touches `~/aqdi/tmp/restart.txt` so Passenger restarts the app.
3. GitHub checks `https://aqdi.phillote.com/health` every 10 seconds for about
   2 minutes. It succeeds only when the app answers `status: "ok"` from a
   process that started after this deploy (`uptimeSeconds` small).

Only a commit that passed CI is deployed. If `main` moved on during the run,
the deploy skips and the newer commit's own run deploys it.

## One-time setup

### 1. The Node.js version in `.cpanel.yml`

The first line of `.cpanel.yml` holds the Node.js version of the `aqdi` app in
cPanel > **Setup Node.js App**. It is set to `22`:

```yaml
    - export NODE_VERSION=22
```

The folder `/home/<your user>/nodevenv/aqdi/22/` must exist (check it in File
Manager). If you ever change the version in cPanel, change this line too. A
wrong value stops the deploy with "Node.js activate script not found" before
anything is copied.

### 2. Create the cPanel API token

1. cPanel > **Security** > **Manage API Tokens** > **Create**.
2. Name: `github-deploy`. Leave the expiration empty, or pick a date and
   remember to renew it.
3. **Copy the token now**: cPanel shows it only once.

The token can do everything your cPanel login can. Keep it only in GitHub
secrets. If it leaks, revoke it on the same page and create a new one.

### 3. Add three GitHub secrets

GitHub > the repository > **Settings** > **Secrets and variables** >
**Actions** > **New repository secret**:

| Name | Value |
|---|---|
| `CPANEL_HOST` | the cPanel server name only, without `https://` and without a port (for example the `serverNNN...` name your host gave you) |
| `CPANEL_USER` | your cPanel user name |
| `CPANEL_API_TOKEN` | the token from step 2 |

Without these three secrets the workflow does not fail: it shows the notice
"Deploy skipped" and does nothing.

Optional: a repository **variable** (not a secret) `HEALTH_URL` changes the
checked address. The default is `https://aqdi.phillote.com/health`.

### 4. The cPanel repository

cPanel > **Git Version Control** must already have the repository cloned at
`/home/<your user>/aqdi-src`, branch `main`. If the repository is private,
cPanel needs its own read access to GitHub (a deploy key), as it does for
"Update from Remote" today.

## Run a deploy by hand

GitHub > **Actions** > **Deploy to cPanel** > **Run workflow** (branch `main`).
It deploys the current `main`, and only if CI passed for that commit.

## Roll back

cPanel always deploys the **latest** `main`. Re-running an old workflow run
deploys today's `main`, not the old commit. To go back:

1. On your computer: `git revert <bad commit>` and push to `main`. The revert
   goes through CI and deploys automatically.
2. Very urgent, and CI cannot wait: in cPanel > **Git Version Control** >
   **Manage**, check out the last good commit, then **Deploy HEAD Commit**
   (the manual fallback). Push a revert afterwards, otherwise the next deploy
   brings the bad commit back.

Database changes are additive, so older code runs on the newer schema. See
`DEPLOY.md` section 9.

## When the deploy fails

The job's last red line says which step failed:

- **"refused the API token (HTTP 401/403)"**: the token was revoked, has
  expired or does not belong to `CPANEL_USER`. Create a new token and update
  the secret.
- **"cPanel did not answer"**: wrong `CPANEL_HOST`, or the host blocks API
  calls from GitHub's servers. Try opening `https://<CPANEL_HOST>:2083` in a
  browser. Your host's support can tell you if port 2083 is filtered.
- **"VersionControl/update: ..."**: cPanel could not pull. The usual causes
  are local changes in `~/aqdi-src` or lost access to GitHub.
- **"did not confirm a restart"**: cPanel accepted the deploy, but the app did
  not come back fresh in time. Open cPanel > **Git Version Control** >
  **Manage** > **Pull or Deploy**: the last deployment log shows the output of
  `deploy/cpanel-deploy.sh`, for example "Node.js activate script not found"
  or "npm install failed". If the deploy finished, open `/health`.
  - `status: "maintenance"`: the app started but is missing a setting. Read
    `/health/detail` (send the `X-Cron-Secret` header).
  - A large `uptimeSeconds`: Passenger did not restart. Use **Restart** in
    Setup Node.js App, then **Run workflow** again.
  - The first deploy, or one that installs new packages, can take longer than
    2 minutes. Wait, check `/health`, and re-run if needed.

The manual path (Update from Remote > Deploy HEAD Commit, then Run NPM Install
and Restart) still works as a fallback: see `DEPLOY.md` section 1.
