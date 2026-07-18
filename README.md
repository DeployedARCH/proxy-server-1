# Basement Stream Proxy Worker

Cloudflare Worker version of the Basement desktop native stream proxy.

## Endpoints

- `GET /health`
- `GET|HEAD /api/stream?url=<encoded-url>`
- `GET|HEAD /api/stream?url=<encoded-url>&headers=<json-headers>`

It forwards media range requests for seeking, rewrites HLS manifests so child playlists and segments go back through the same Worker, and adds CORS headers for browser/mobile playback.

## Run

```bash
pnpm install
pnpm run dev
pnpm run deploy
```

After deploying, give the Worker URL back to Codex and it can be added to Basement as the website/mobile override proxy.
