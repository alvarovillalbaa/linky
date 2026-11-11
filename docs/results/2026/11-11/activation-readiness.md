# Hosted activation check

The dedicated Linky project `bfteqhtzyzrinzxmgiee` reports `ACTIVE_HEALTHY`.
The connected Supabase project lookup exposes its direct database host and
version, but supplies no pooler connection details.

The connected Vercel environment listing returned HTTP 403 for
`GET /v10/projects/{idOrName}/env`. It reported insufficient permission to
list project environment variables. The suggested CLI fallback is unavailable
because the Vercel CLI is absent from the current environment.

Chrome inventory works through the browser extension. Opening a task tab failed
through the documented browser APIs. The documented native alternative then
failed to start its connection. The Supabase dashboard could not be inspected.

Live runtime binding and hosted owner/recipient checks remain pending. The
source and dedicated schema remain at their previous acceptance boundaries.
The next activation step needs the exact transaction pooler host, port and
custom-role user pattern, plus working access to Linky's Vercel environment
settings. Keep credentials in the service's private configuration.
