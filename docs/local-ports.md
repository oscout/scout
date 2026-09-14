# Local Ports

OpenScout keeps its stable local development and runtime services in a small
Scout-owned block instead of using common framework defaults such as `3000`,
`5173`, `8000`, or ad hoc values.

The default range is `43100-43199`. This sits below the common dynamic/private
TCP range `49152-65535`, which many operating systems use for ephemeral client
ports, while staying well above privileged system ports.

| Service | Default port | Notes |
| --- | ---: | --- |
| Broker HTTP/SSE/API | `43110` | `OPENSCOUT_BROKER_PORT` overrides |
| Web app server | `43120` | `OPENSCOUT_WEB_PORT` / `SCOUT_WEB_PORT` override |
| Web terminal relay | `43121` | Defaults to web port + 1 |
| Vite asset server | `43122` | `OPENSCOUT_WEB_VITE_URL` or dev flags override |
| Pairing bridge | `43130` | `OPENSCOUT_PAIRING_PORT` / `SCOUT_PAIRING_PORT` / `~/.openscout/config.json` override |
| Pairing relay | `43131` | Defaults to pairing bridge + 1 |
| Pairing file server | `43132` | Defaults to pairing bridge + 2 |
| Design studio | `43140` | `design/studio` Next dev server |

### Shared local edge

Only one Caddy instance should own ports `80` and `2019`. Independent Caddy
processes can both bind these ports on macOS and silently answer another
service's hostname with an empty HTTP 200 response.

Scout preserves operator-owned site blocks in `~/.scout/local-edge/sites/*.caddy`
when generating its Caddyfile. Use these snippets to forward companion hostnames
to distinct upstream ports. Validate the generated config before reloading the
Scout admin endpoint; never hand-edit generated route blocks as the lasting fix.

On this development machine, `studio.local` and `*.studio.local` forward to
Studio's private HTTP edge on `127.0.0.1:43181`; Studio's admin endpoint is
`127.0.0.1:43182`, and its supervisor stays on `43180`. Studio's LaunchAgent sets
`STUDIO_LOCAL_PRIVATE_HTTP_PORT=43181` and `CADDY_ADMIN=127.0.0.1:43182` with
`--scheme http`. Preserve these overrides when reinstalling that service.
Verify both hostnames and JSON API bodies after changes: a successful direct
web-port probe alone does not establish that public hostname routing works.

Additional git worktrees use deterministic adjacent bands to avoid colliding
with the main checkout:

| Service | Worktree band |
| --- | ---: |
| Web app server | `43200-43899` |
| Vite asset server | `43900-44599` |
| Pairing bridge | `44600-45299` |

Ports with established protocol meaning stay conventional. The local edge uses
HTTP `80` and HTTPS `443` when enabled, and SSH terminal access remains port
`22` when a host reports that capability.

In dev mode with Vite enabled, `/ws/hmr` stays on the Bun app server
(`43120` by default). Bun relays the Vite HMR WebSocket to the internal asset
server (`43122` by default), so hot reload works through `scout.local` without
opening the raw Vite port in the browser.

`scout setup` creates missing local config as part of bootstrap. Use
`scout init --force --broker-port <n> --web-port <n> --pairing-port <n>` when
you only want to rewrite `~/.openscout/config.json`. Existing
`~/.openscout/config.json` values and environment variables are still
authoritative. Delete or update local port overrides if you want an existing
machine to move to these defaults.

Pairing's legacy `~/.scout/pairing/config.json` can still provide a port for old
runtime flows, but it sits below the shared `~/.openscout/config.json` machine
port.

Mobile clients should not treat every port in the initial pairing payload as
permanent. The QR/deep link is only the bootstrap route for establishing the
encrypted bridge session. After that session is established, trusted clients can
call the protected `mobile.endpoints` bridge RPC to fetch the machine's current
service coordinates and refresh their saved relay route inventory. That
discovery data is intentionally not served by a naked public HTTP endpoint.
