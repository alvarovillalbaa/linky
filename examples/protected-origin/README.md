# Protect a private file

Import `createProtectedResource` from `server/protected-resource.mjs` in the server
that owns your resource. Wrap every GET/HEAD route that can return its bytes.
Keep its file outside public/static folders and bypassing CDN caches. The guard
authorizes before streaming and denies redirects, cookies, wrong URLs and failed
or malformed Linky decisions. Downloaded copies cannot be recalled.

The included server is a minimal HTTPS example, not a hosting service. Configure
these server environment variables through your existing secret manager:

- `LINKY_ORIGIN`: your configured HTTPS Linky origin.
- `LINKY_ORIGIN_CREDENTIAL_ID`, `LINKY_ORIGIN_KEY`, `LINKY_RESOURCE_URL`: from the
  owner's explicitly downloaded host configuration, after issuing a host key.
- `LINKY_PRIVATE_FILE`: an existing private file path on this host.
- `LINKY_TLS_CERT_FILE`, `LINKY_TLS_KEY_FILE`: your existing certificate/key files.

Run `node examples/protected-origin/server.mjs` with those variables supplied by
the host. It listens on HTTPS port 443; the certificate and DNS must match the
exact resource URL. Do not print environment values or incoming authorization
headers. Do not add a public file route or put private bytes in the Linky repo.
For a different deployment, adapt the native Request/Response handler to your
existing server and verified TLS; never trust forwarding headers from visitors.

After redeeming, recipients prepare a separate access key in Linky and explicitly
download. Only that key and X-Linky-Access-Id reach the host. A custom client uses
Bearer resource access and that ID on the exact configured URL. Host integration
keys stay server-only and cannot redeem grants or ingest conversions.

The browser downloader handles attachments up to 20 MiB within 10 seconds. This
server/guard streams; clients for larger files must keep the same authorization,
no-cache and no-redirect rules. Uses count committed redemptions, not downloads.
