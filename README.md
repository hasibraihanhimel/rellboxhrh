# Reelbox

Reelbox is a lightweight movie and series discovery UI with a FastAPI backend and a same-origin media proxy. It is packaged to run locally or on a Docker-compatible host without Manus-specific runtime dependencies.

## Fastest local setup: Docker

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Open a terminal inside this folder.
3. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell use:

   ```powershell
   Copy-Item .env.example .env
   ```

4. Start Reelbox:

   ```bash
   docker compose up --build -d
   ```

5. Open **http://localhost:3000**.
6. Stop it with:

   ```bash
   docker compose down
   ```

The app exposes a health check at `http://localhost:3000/healthz`.

## Local setup without Docker

Requires Python 3.12+.

```bash
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn api:app --host 0.0.0.0 --port 3000
```

Then open **http://localhost:3000**.

## Configuration

Copy `.env.example` to `.env` and edit only the values you need:

- `PORT`: local/server port; default `3000`.
- `MOVIEBOX_BASE_URL`: upstream website base URL.
- `MOVIEBOX_API_BASE`: upstream API base URL.
- `REQUEST_TIMEOUT_SECONDS`: upstream request timeout; default `18`.
- `ALLOWED_ORIGINS`: comma-separated browser origins, or `*` for the single-container app.
- `PUBLIC_URL`: optional public URL used for sitemap links.

Never commit `.env`; it is ignored by Docker and should remain private.

## Deploy anywhere

Use the included `Dockerfile` on any service that supports Docker containers. The service must:

1. Build from the repository root.
2. Start the container using the Dockerfile command.
3. Allow the app to listen on `0.0.0.0`.
4. Pass its assigned port through the `PORT` environment variable.
5. Use `/healthz` as the health check when supported.

This works with a local server, Render, Railway, Fly.io, a VPS, Docker Desktop, or another Docker host. The frontend and API are served from one origin, so no separate frontend build is required.

## Streaming notes

Playback uses the `/api/media/...` range-aware proxy. A `206 Partial Content` response is required for seeking and browser playback. The upstream provider must still have a valid source for the selected title and episode; titles without an upstream resource will correctly show that no stream is available.

To test a source manually:

```bash
curl -i -r 0-1023 http://localhost:3000/api/media/SUBJECT_ID/1/1/0?detail_path=TITLE_SLUG
```

## Project layout

- `api.py` — FastAPI app, upstream API client, static serving, and media proxy.
- `static/` — dependency-free Reelbox frontend.
- `Dockerfile` — portable production container.
- `docker-compose.yml` — one-command local deployment.
- `.env.example` — safe configuration template.
