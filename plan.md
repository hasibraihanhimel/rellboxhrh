# Reelbox Implementation Plan

## Product scope

Reelbox is a fast, responsive movie and TV discovery and playback website built on the provided Moviebox FastAPI project. It uses the existing same-origin endpoints for home sections, catalogs, search, details, stream sources, and captions without changing their response contracts. The UI will present current/trending content, category browsing, search, title details, and watching flows for movies and series.

## Architecture

- **Serving model:** one FastAPI application serves the HTML/CSS/JavaScript frontend from `static/` and preserves all existing API routes. This keeps browser requests same-origin and avoids a second proxy hop or CORS setup in production.
- **Frontend:** dependency-free HTML/CSS/ES modules for a small first load, with client-side routing using URL paths and query parameters. The browser owns navigation and media controls; the API remains the source of truth for content and playback.
- **Player:** native HTML5 `<video>` with a custom control bar. Stream sources are fetched only when the user starts watching. Quality choices are mapped to MP4/HLS/DASH candidates when available, captions are converted to text tracks, and audio tracks are exposed when the browser/source provides them. The player preserves the current time while switching source quality.
- **Performance:** lazy poster loading, skeleton UI, request deduplication, a bounded in-memory/localStorage cache for public JSON, debounced suggestions, prefetching of the next catalog page near the viewport, and no data requests for hidden views. API calls use `AbortController` and stale-result protection.
- **Freshness:** homepage content is revalidated for a short client cache lifetime so new/trending sections appear automatically on return. Catalog and search pages paginate with an end condition from the API's `total` value.

## User-facing routes

- `/` home with hero, trending, new/popular sections, and category rails
- `/movies`, `/tv-series`, `/animation` catalog views with infinite scrolling
- `/search?q=...` debounced search and infinite results
- `/title/:slug` detail view with metadata and watch action
- `/watch/:subjectId` playback view with `slug`, `se`, and `ep` query parameters

## Backend additions

- Mount `static/` and serve `index.html` for page routes while keeping `/home`, `/movies`, `/tv-series`, `/animation`, `/search`, `/detail/*`, and `/api/stream/*` dynamic.
- Add `/healthz`, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`, and `manus-routes.json`.
- Keep upstream access terms and lawful-use notice visible in the footer and player error states.
- Add small async response caching for public home/catalog/search/detail data to reduce repeated upstream calls while preserving short TTL freshness.

## Validation

- Syntax-check the Python backend and run existing verification where reachable.
- Start Uvicorn on the managed runtime port and validate the route manifest, health endpoint, static shell, API response parsing, search pagination, and stream/caption response contracts using HTTP requests.
- Run the frontend through a browser-independent static check: inspect that all expected routes and controls are present, and validate JavaScript syntax with Node's check mode.
- Review the final source for same-origin URLs, lazy loading, retry/end states, and no invented API fields.

## Deployment and cache policy

- Portable single-container deployment: the same FastAPI process serves the frontend, JSON APIs, health check, and range-aware media proxy. It binds to `HOST`/`PORT` and has no Manus-only runtime dependency.
- `Dockerfile` is the provider-neutral production contract; `docker-compose.yml`, `.env.example`, `run-local.sh`, and `run-local.bat` provide beginner-friendly local startup paths.
- Static assets are served with immutable caching; HTML and JSON data are short-lived/revalidated because titles and streams change.
- Upstream endpoints, request timeout, CORS origins, and public sitemap origin are environment-configurable without code edits or committed secrets.
- No user-specific data is stored or shared. API payloads remain public and cacheable only for the short TTL implemented by the app.

## Project structure

- `api.py`: existing upstream API client and new static/health/document serving
- `static/index.html`: app shell and semantic SEO fallback content
- `static/styles.css`: responsive visual system and player/catalog styling
- `static/app.js`: routing, data fetching, cache, rendering, infinite scroll, and player interactions
- `static/reelbox-mark.svg` / `static/reelbox-icon.png`: project-specific brand identity
- `static/manus-routes.json`: source route manifest
- `Dockerfile`: production container startup
- `ideas.md`: design direction and consistency rules
