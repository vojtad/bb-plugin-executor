# Set up Executor for BB

This is an example setup: Executor v2 in Docker, reachable through a Cloudflare
Tunnel, optionally behind Cloudflare Access. It is the same setup as
`services/executor` in the dev-server repo. Upstream docs:
[Self-host](https://executor.sh/docs/run/self-host).

## 1. Put Cloudflare in front

Set up Access before you start Executor. The first person to finish the
Executor setup becomes its owner, and without Access anyone who finds the URL
first can do it.

1. In Cloudflare Zero Trust, go to **Networks > Tunnels** and create a tunnel
   of type **Cloudflared**, for Executor only. Copy its token.
2. Add a public hostname to the tunnel: your hostname, service **HTTP**, URL
   `executor:4400`.
3. Optional, Access: in **Access > Applications**, add a **Self-hosted**
   application for the whole hostname, with an **Allow** policy for your
   email.

## 2. Run Executor

Put these two files in a directory on the server. On a shared server, give the
directory a unique name such as `executor-<user>`: Docker Compose names the
containers and the volume after it.

`docker-compose.yml`:

```yaml
services:
  executor:
    image: ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.66
    restart: unless-stopped
    init: true
    environment:
      - BETTER_AUTH_URL=${BETTER_AUTH_URL:?set BETTER_AUTH_URL in .env}
    volumes:
      - data:/app/data

  cloudflared:
    image: cloudflare/cloudflared:2026.11.1
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${TUNNEL_TOKEN:?set TUNNEL_TOKEN in .env}
    depends_on:
      - executor

volumes:
  data:
```

`.env` (run `chmod 600 .env`):

```sh
# Public URL of Executor, for example https://executor.example.dev
BETTER_AUTH_URL=https://<hostname>
# Token of the Cloudflare Tunnel that serves Executor
TUNNEL_TOKEN=<tunnel token>
```

Then run `docker compose up -d`, open `https://<hostname>` and finish the
Executor setup.

Executor publishes no host ports; only the tunnel reaches it. To update,
change the image tags, then run `docker compose pull && docker compose up -d`.
Back up the whole `data` volume: it holds Executor's data and the keys it
creates on first boot.

## 3. Let MCP clients through Access

Skip this without Access. If someone else runs the Executor, ask them for
these values.

Executor accepts only its own tokens, so the plugin passes Access with a
service token:

1. In Zero Trust, go to **Access > Service Auth > Service Tokens** and create a
   service token. Copy the client ID and the client secret; Cloudflare shows
   the secret only once.
2. On the Executor application, add a policy with the action **Service Auth**
   that includes the service token. Keep your **Allow** policy: signing in
   still goes through Access in your browser.

## 4. Connect BB

1. Open **Executor** in the BB sidebar.
2. Set **MCP URL** to `https://<hostname>/mcp`.
3. With Access: open **Cloudflare Access** and enter the client ID and the
   client secret.
4. Click **Save**, then **Sign in**. You sign in to Cloudflare (with Access)
   and then to Executor.
5. On Executor's consent page, pick **model** approvals if you want BB's
   auto-approve rules to decide. See below.

The status shows Connected and the panel lists your apps.

Instead of signing in, you can use an optional Executor API key: in Executor,
open your avatar > **Account settings** > **Tokens** and create a key for one
organization, then enter it under **API key** in the panel.

## Approval modes

The mode is chosen on Executor's consent page when you sign in. With an API
key, the plain `/mcp` URL means model mode. The panel shows the active one.

| Mode | Who approves an action | Auto-approve rules |
|---|---|---|
| model | your rules, then a prompt in the thread | used |
| automatic | Executor, without asking | not used |
| native | a prompt in the thread for every approval; `executor_call` is not gated at all | not used |
| browser | Executor's approval page, linked from the prompt | not used |

To change the mode, click **Sign in again** and pick another one.

## Other MCP clients

Behind Access, a client sends the service token on every request to
`https://<hostname>/mcp`. A client that cannot sign in also sends an Executor
API key (see above for how to create one).

```
CF-Access-Client-Id: <client ID>
CF-Access-Client-Secret: <client secret>
Authorization: Bearer <Executor API key>
```

If a Cloudflare header is missing or wrong, the client gets a 302 redirect to
`cloudflareaccess.com`, not a 401.

## Connect apps

Add apps in Executor, then connect each account there. For Google and Slack
you need your own OAuth clients, with the redirect URI
`https://<hostname>/api/oauth/callback`.
