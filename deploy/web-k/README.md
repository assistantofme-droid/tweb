# 7eve9Chat web at `/web-k/` on another server

The app is served at `https://your-server/web-k/`. The browser only ever talks
to that server: nginx passes `/web-k/api`, `/web-k/uploads` and
`/web-k/socket.io` on to `https://7eve9craft.ir`. The backend therefore needs no
CORS for your domain, and nothing on 7eve9craft.ir has to change.

```
browser ──> your-server/web-k/            the app (static files)
        ──> your-server/web-k/api/...       ─┐
        ──> your-server/web-k/uploads/...    ├─> https://7eve9craft.ir/...
        ──> your-server/web-k/socket.io/...  ─┘
```

The app is built with `VITE_SEVEN_NINE_ORIGIN=/web-k` (backend on this same
server, under `/web-k`). Public links it creates still point at
`https://7eve9craft.ir` (`VITE_SEVEN_NINE_SITE`).

## First: can the server reach the backend?

```sh
curl -sI https://7eve9craft.ir/api/auth/me    # expect 401 (no token), not a timeout
```

## A. With Docker

```sh
git clone -b claude/dazzling-knuth-iwjcks https://github.com/assistantofme-droid/tweb
cd tweb
docker compose -f deploy/web-k/docker-compose.yml up -d --build
```

The app is then at `http://your-server:8080/web-k/`. If Docker Hub or npm can't
be reached from the server, set the `args` in `docker-compose.yml` to mirrors.

## B. With the nginx you already run

Build (Node 22.18+ or 24.11+):

```sh
corepack enable
pnpm install
VITE_SEVEN_NINE_ORIGIN=/web-k pnpm exec vite build
node deploy/web-k/assemble.js /var/www/web-k
```

Then, from `nginx.conf` in this folder, copy the `map` block into your `http`
block, and the proxy settings and `location` blocks into your HTTPS `server`
block. Set `root` in `location /web-k/` to `/var/www` (the folder that holds
`web-k/`), and run `nginx -t && nginx -s reload`.

## Notes

- **HTTPS is required** (the service worker, notifications, and microphone and
  camera access only work there). With Docker, put your HTTPS nginx or proxy in
  front of port 8080.
- All requests reach the backend from this server's IP. `X-Forwarded-For` is
  passed on, but if the backend limits requests per IP (sign-in codes, for
  example) and doesn't trust that header, every user shares this server's limit.
- Uploads up to 2 GB go through (`client_max_body_size`); raise it if the
  backend allows more.
