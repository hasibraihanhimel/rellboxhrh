import re
import json
import httpx
import asyncio
from urllib.parse import quote
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pathlib import Path
import os
from fastapi.responses import HTMLResponse, FileResponse, Response, StreamingResponse

app = FastAPI(
    title="MovieBox API Pro",
    description="Full Pure REST API for moviebox.ph — Zero Scraping",
    version="2.1.5"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",") if origin.strip()] or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

BASE_URL = os.getenv("MOVIEBOX_BASE_URL", "https://moviebox.ph").rstrip("/")
API_BASE = os.getenv("MOVIEBOX_API_BASE", "https://h5-api.aoneroom.com/wefeed-h5api-bff").rstrip("/")
REQUEST_TIMEOUT_SECONDS = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "18"))

_bearer_token: str | None = None

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Referer": f"{BASE_URL}/",
    "Origin": BASE_URL,
    "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
    "X-Request-Lang": "en",
    "Accept": "application/json",
    "Content-Type": "application/json",
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
}

# Player-side headers for the stream domain (netfilm.world)
STATIC_DIR = Path(__file__).parent / "static"
CACHE_TTL_SECONDS = 18
_response_cache: dict[str, tuple[float, dict]] = {}
_player_cache: dict[str, tuple[float, dict]] = {}
_player_inflight: dict[str, asyncio.Task] = {}
_http_client: httpx.AsyncClient | None = None
_http_client_lock = asyncio.Lock()
_token_lock = asyncio.Lock()
PLAYER_CACHE_TTL_SECONDS = 30
CACHEABLE_POST_PATHS = ("/subject/filter", "/subject/search", "/subject/search-suggest")
UPLOAD_MARKERS = ("mix", "playlist", "music", "song", "songs", "sounds", "youtube", "reaction", "challenge", "tiktok", "karaoke", "remix", "podcast", "interview", "news", "beef", "prank")

PLAYER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
    "X-Source": "",
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

async def _get_http_client() -> httpx.AsyncClient:
    """Reuse a small connection pool instead of opening a client per request."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        async with _http_client_lock:
            if _http_client is None or _http_client.is_closed:
                _http_client = httpx.AsyncClient(
                    follow_redirects=True,
                    timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=min(8.0, REQUEST_TIMEOUT_SECONDS)),
                    limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
                )
    return _http_client


@app.on_event("shutdown")
async def close_http_client():
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()
    _http_client = None


async def _get_bearer_token() -> str:
    """Auto-acquire a guest JWT from the x-user response header."""
    global _bearer_token
    if _bearer_token:
        return _bearer_token
    async with _token_lock:
        if _bearer_token:
            return _bearer_token
        client = await _get_http_client()
        resp = await client.get(f"{API_BASE}/home?host=moviebox.ph", headers=DEFAULT_HEADERS)
        x_user = resp.headers.get("x-user")
        if x_user:
            _bearer_token = json.loads(x_user).get("token")
        if not _bearer_token:
            # fallback: read from set-cookie
            cookie = resp.headers.get("set-cookie", "")
            import re as _re
            m = _re.search(r"token=([^;]+)", cookie)
            if m:
                _bearer_token = m.group(1)
    return _bearer_token or ""

async def _make_request(url: str, method: str = "GET", payload: dict = None, custom_headers: dict = None) -> dict:
    global _bearer_token
    cache_key = f"{method}:{url}:{json.dumps(payload or {}, sort_keys=True, default=str)}"
    now = asyncio.get_running_loop().time()
    is_cacheable = (method == "GET" and not any(part in url for part in ("/media-player/", "/subject/play", "/subject/caption"))) or (method == "POST" and any(part in url for part in CACHEABLE_POST_PATHS))
    if is_cacheable:
        cached = _response_cache.get(cache_key)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
    token = await _get_bearer_token()
    headers = {
        **DEFAULT_HEADERS,
        "Authorization": f"Bearer {token}" if token else "",
        **(custom_headers or {})
    }
    client = await _get_http_client()
    try:
        if method == "POST":
            resp = await client.post(url, headers=headers, json=payload)
        else:
            resp = await client.get(url, headers=headers)

        # Refresh token if server sends a new one
        x_user = resp.headers.get("x-user")
        if x_user:
            new_token = json.loads(x_user).get("token")
            if new_token:
                _bearer_token = new_token

        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Upstream API error: {resp.status_code}")

        result = resp.json()
        if is_cacheable:
            _response_cache[cache_key] = (asyncio.get_running_loop().time(), result)
            if len(_response_cache) > 256:
                cutoff = asyncio.get_running_loop().time() - CACHE_TTL_SECONDS
                for key, (created, _) in list(_response_cache.items()):
                    if created < cutoff:
                        _response_cache.pop(key, None)
        return result
    except Exception as e:
        if isinstance(e, HTTPException): raise e
        raise HTTPException(status_code=502, detail=f"Request failed: {str(e)}")

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    """Serve the fast Reelbox application shell."""
    return FileResponse(
        STATIC_DIR / "index.html",
        media_type="text/html",
        headers={"Cache-Control": "no-cache"},
    )

@app.get("/home")
async def get_home():
    url = f"{API_BASE}/home?host=moviebox.ph"
    data = await _make_request(url)
    sections = []
    for op in data.get("data", {}).get("operatingList", []) or []:
        op_type = op.get("type")
        title = op.get("title", "Featured")
        if op_type == "BANNER":
            items = [{
                "name": item.get("title") or (item.get("subject") or {}).get("title"),
                "poster_url": item.get("image", {}).get("url") or (item.get("subject") or {}).get("cover", {}).get("url"),
                "slug": item.get("detailPath") or (item.get("subject") or {}).get("detailPath"),
                "subject_id": (item.get("subject") or {}).get("subjectId"),
                "badge": (item.get("subject") or {}).get("corner")
            } for item in op.get("banner", {}).get("items", []) if item.get("title") and "Communities" not in item.get("title")]
            sections.append({"section": "Banner", "count": len(items), "items": items})
        elif op_type in ["SUBJECTS_MOVIE", "SUBJECTS_TV", "SUBJECTS_ANIMATION"]:
            raw_subjects = op.get("subjects") or op.get("items") or op.get("list") or []
            if isinstance(raw_subjects, dict):
                raw_subjects = raw_subjects.get("items") or raw_subjects.get("subjects") or []
            items = [{
                "name": sub.get("title"),
                "poster_url": sub.get("cover", {}).get("url"),
                "slug": sub.get("detailPath"),
                "subject_id": sub.get("subjectId"),
                "badge": sub.get("corner"),
                "rating": sub.get("imdbRatingValue")
            } for sub in raw_subjects if isinstance(sub, dict)]
            sections.append({"section": title, "count": len(items), "items": items})
    return {"status": "success", "sections": sections}

def _subject_type(subject: dict) -> int:
    try:
        return int(subject.get("subjectType") or subject.get("subject_type") or subject.get("type") or 0)
    except (TypeError, ValueError):
        return 0


def _is_animation_subject(subject: dict, section_title: str) -> bool:
    markers = ("anime", "animation", "cartoon", "kids", "nursery")
    haystack = " ".join((str(subject.get("title", "")), str(subject.get("genre", "")))).lower()
    return any(marker in haystack for marker in markers)


def _is_upload_like(subject: dict) -> bool:
    haystack = " ".join((str(subject.get("title", "")), str(subject.get("genre", "")))).lower()
    return any(marker in haystack for marker in UPLOAD_MARKERS)


async def _get_category_data(category: str, page: int = 1, per_page: int = 24, sort: str = "RECOMMEND") -> dict:
    """Build clean catalogs from labeled home rails; the filter endpoint now mixes uploads with titles."""
    data = await _make_request(f"{API_BASE}/home?host=moviebox.ph")
    subjects = {}
    for section in data.get("data", {}).get("operatingList", []) or []:
        section_title = str(section.get("title") or "")
        for subject in section.get("subjects", []) or []:
            if not isinstance(subject, dict):
                continue
            subject_type = _subject_type(subject)
            if category == "movies":
                matches = subject_type == 1 and not _is_upload_like(subject)
            elif category == "animation":
                matches = subject_type == 2 and _is_animation_subject(subject, section_title) and not _is_upload_like(subject)
            else:
                matches = subject_type == 2 and not _is_animation_subject(subject, section_title) and not _is_upload_like(subject)
            if matches and subject.get("subjectId"):
                subjects[str(subject["subjectId"])] = subject

    selected = list(subjects.values())
    if sort == "LATEST":
        selected.sort(key=lambda item: str(item.get("releaseDate") or ""), reverse=True)
    elif sort == "IMDB":
        selected.sort(key=lambda item: float(item.get("imdbRatingValue") or 0), reverse=True)
    elif sort == "MOST_WATCHED":
        selected.sort(key=lambda item: float(item.get("imdbRatingCount") or 0), reverse=True)
    start = max(0, page - 1) * per_page
    items = [{
        "name": sub.get("title"),
        "poster_url": (sub.get("cover") or {}).get("url"),
        "slug": sub.get("detailPath"),
        "subject_id": sub.get("subjectId"),
        "badge": sub.get("corner"),
        "rating": sub.get("imdbRatingValue"),
        "year": sub.get("releaseDate", "")[:4] if sub.get("releaseDate") else None,
        "category": category,
    } for sub in selected[start:start + per_page]]
    return {"page": page, "per_page": per_page, "total": len(selected), "items": items}

@app.get("/movies")
async def get_movies(request: Request, page: int = 1, sort: str = "RECOMMEND"):
    if "text/html" in request.headers.get("accept", "").lower():
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})
    return await _get_category_data(category="movies", page=page, sort=sort)

@app.get("/tv-series")
async def get_tv_series(request: Request, page: int = 1, sort: str = "RECOMMEND"):
    if "text/html" in request.headers.get("accept", "").lower():
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})
    return await _get_category_data(category="tv-series", page=page, sort=sort)

@app.get("/animation")
async def get_animation(request: Request, page: int = 1, sort: str = "RECOMMEND"):
    if "text/html" in request.headers.get("accept", "").lower():
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})
    return await _get_category_data(category="animation", page=page, sort=sort)

@app.get("/search/suggest")
async def get_search_suggestions(q: str = Query(..., min_length=1)):
    url = f"{API_BASE}/subject/search-suggest"
    data = await _make_request(url, method="POST", payload={"keyword": q, "perPage": 10})
    inner = data.get("data", {})
    raw = inner.get("items", inner.get("list", []))
    suggestions = []
    for item in raw:
        sub = item.get("subject") or {}
        suggestions.append({
            "title": sub.get("title") or item.get("word") or item.get("title"),
            "slug": sub.get("detailPath") or item.get("detailPath"),
            "subject_id": sub.get("subjectId") or item.get("subjectId")
        })
    return {"suggestions": suggestions}

@app.get("/search")
async def search(request: Request, q: str = Query(..., min_length=1), page: int = 1):
    if "text/html" in request.headers.get("accept", "").lower():
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})
    url = f"{API_BASE}/subject/search"
    data = await _make_request(url, method="POST", payload={"keyword": q, "page": page, "perPage": 20})
    inner = data.get("data", {})
    raw = inner.get("items", inner.get("list", []))
    if isinstance(raw, dict):
        raw = raw.get("items") or raw.get("subjects") or raw.get("list") or []
    items = [{
        "name": (sub.get("subject") or sub).get("title"),
        "poster_url": ((sub.get("subject") or sub).get("cover") or {}).get("url"),
        "slug": (sub.get("subject") or sub).get("detailPath"),
        "subject_id": (sub.get("subject") or sub).get("subjectId"),
        "subject_type": _subject_type(sub.get("subject") or sub),
    } for sub in raw if _subject_type(sub.get("subject") or sub) in (1, 2) and not _is_upload_like(sub.get("subject") or sub)]
    pager = inner.get("pager", {})
    total = pager.get("totalCount") or inner.get("total") or len(items)
    return {"query": q, "page": page, "total": total, "items": items}

@app.get("/detail/{slug}")
async def get_movie_detail(slug: str):
    url = f"{API_BASE}/detail?detailPath={slug}"
    return await _make_request(url)

@app.get("/api/stream/{subject_id}")
async def get_stream_sources(subject_id: str, detail_path: str, se: int = 1, ep: int = 1):
    se, ep = await _resolve_playback_episode(subject_id, detail_path, se, ep)
    data = await _get_player_data(subject_id, detail_path, se, ep)

    has_resource = data.get("hasResource", False)
    streams = []
    for index, s in enumerate(data.get("streams", [])):
        streams.append({
            "resolution": f"{s.get('resolutions')}p",
            "format": s.get("format"),
            "url": s.get("url"),
            "direct_url": s.get("url"),
            "playback_url": f"/api/media/{subject_id}/{se}/{ep}/{index}?detail_path={quote(detail_path)}" if s.get("url") else "",
            "size": s.get("size"),
            "duration": s.get("duration"),
            "codec": s.get("codecName"),
            "language": s.get("language") or s.get("lang") or s.get("audioLanguage") or s.get("audioLang") or s.get("languageName")
        })
    return {
        "subject_id": subject_id,
        "se": se,
        "ep": ep,
        "has_resource": has_resource,
        "sources": streams,
        "hls": data.get("hls", []),
        "dash": data.get("dash", []),
        "audio": data.get("audio", []) or data.get("audioTracks", []) or data.get("audio_tracks", []),
        "free_episodes": data.get("freeNum"),
        "limited": data.get("limited", False),
        "available": bool(has_resource and streams),
        "coming_soon": not bool(has_resource and streams),
        "note": None if has_resource and streams else "This title is coming soon because no stream is uploaded yet."
    }

@app.get("/api/media/{subject_id}/{se}/{ep}/{source_index}")
async def proxy_media(subject_id: str, se: int, ep: int, source_index: int, request: Request, detail_path: str):
    """Proxy signed media with range support and the upstream player referer."""
    data = await _get_player_data(subject_id, detail_path, se, ep)
    streams = data.get("streams", [])
    if source_index < 0 or source_index >= len(streams) or not streams[source_index].get("url"):
        raise HTTPException(status_code=404, detail="Media source unavailable")

    dom_data = await _make_request(f"{API_BASE}/media-player/get-domain")
    domain = dom_data.get("data", "https://netfilm.world").rstrip("/")
    player_referer = f"{domain}/spa/videoPlayPage/movies/{detail_path}?id={subject_id}&type=/movie/detail&detailSe={se}&detailEp={ep}&lang=en"
    forward_headers = {
        "User-Agent": PLAYER_HEADERS["User-Agent"],
        "Accept": "*/*",
        "Accept-Encoding": "identity",
        "Origin": domain,
        "Referer": player_referer,
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
    }
    if request.headers.get("range"):
        forward_headers["Range"] = request.headers["range"]

    client = await _get_http_client()
    media_url = streams[source_index]["url"]
    upstream_request = client.build_request("GET", media_url, headers=forward_headers)
    upstream = await client.send(upstream_request, stream=True)
    if upstream.status_code == 426:
        await upstream.aread()
        await upstream.aclose()
        # Some CDN edges reject the player-page referer; retry with the stable
        # media origin referer that also works for direct browser range requests.
        retry_headers = {
            "User-Agent": PLAYER_HEADERS["User-Agent"],
            "Accept": "*/*",
            "Accept-Encoding": "identity",
            "Origin": domain,
            "Referer": f"{domain}/",
            "Sec-Fetch-Dest": "video",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
        }
        if request.headers.get("range"):
            retry_headers["Range"] = request.headers["range"]
        upstream = await client.send(client.build_request("GET", media_url, headers=retry_headers), stream=True)
    if upstream.status_code >= 400:
        await upstream.aread()
        await upstream.aclose()
        raise HTTPException(status_code=502, detail=f"Media source error: {upstream.status_code}")

    response_headers = {}
    for header in ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"):
        if header in upstream.headers:
            response_headers[header] = upstream.headers[header]

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, headers=response_headers, media_type=upstream.headers.get("content-type"))

@app.get("/api/stream/{subject_id}/captions")
async def get_captions(subject_id: str, detail_path: str, se: int = 1, ep: int = 1):
    se, ep = await _resolve_playback_episode(subject_id, detail_path, se, ep)
    play_data = await _get_player_data(subject_id, detail_path, se, ep)

    streams = play_data.get("streams", [])
    dash = play_data.get("dash", [])

    stream_id = None
    stream_format = None
    if streams:
        stream_id = streams[0].get("id")
        stream_format = streams[0].get("format", "MP4")
    elif dash:
        stream_id = dash[0].get("id")
        stream_format = dash[0].get("format", "DASH")

    if not stream_id:
        return {"subject_id": subject_id, "se": se, "ep": ep, "count": 0, "captions": []}

    cap_url = (
        f"{API_BASE}/subject/caption"
        f"?format={stream_format}&id={stream_id}&subjectId={subject_id}&detailPath={detail_path}"
    )
    data = await _make_request(cap_url)
    inner = data.get("data", {})
    captions = inner.get("captions", []) if isinstance(inner, dict) else inner
    return {"subject_id": subject_id, "se": se, "ep": ep, "count": len(captions), "captions": captions}


async def _get_player_data(subject_id: str, detail_path: str, se: int, ep: int) -> dict:
    """Deduplicate concurrent stream/caption lookups for the same episode."""
    cache_key = f"{subject_id}:{detail_path}:{se}:{ep}"
    now = asyncio.get_running_loop().time()
    cached = _player_cache.get(cache_key)
    if cached and now - cached[0] < PLAYER_CACHE_TTL_SECONDS:
        return cached[1]

    inflight = _player_inflight.get(cache_key)
    if inflight:
        return await asyncio.shield(inflight)

    async def load() -> dict:
        dom_data = await _make_request(f"{API_BASE}/media-player/get-domain")
        domain = dom_data.get("data", "https://netfilm.world").rstrip("/")
        player_referer = (
            f"{domain}/spa/videoPlayPage/movies/{detail_path}"
            f"?id={subject_id}&type=/movie/detail&detailSe={se}&detailEp={ep}&lang=en"
        )
        play_url = f"{domain}/wefeed-h5api-bff/subject/play?subjectId={subject_id}&se={se}&ep={ep}&detailPath={detail_path}"
        client = await _get_http_client()
        resp = await client.get(play_url, headers={**PLAYER_HEADERS, "Referer": player_referer})
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Player API error: {resp.status_code}")
        data = resp.json().get("data", {})
        _player_cache[cache_key] = (asyncio.get_running_loop().time(), data)
        if len(_player_cache) > 128:
            cutoff = asyncio.get_running_loop().time() - PLAYER_CACHE_TTL_SECONDS
            for key, (created, _) in list(_player_cache.items()):
                if created < cutoff:
                    _player_cache.pop(key, None)
        return data

    task = asyncio.create_task(load())
    _player_inflight[cache_key] = task
    task.add_done_callback(lambda _: _player_inflight.pop(cache_key, None))
    return await asyncio.shield(task)


async def _resolve_playback_episode(subject_id: str, detail_path: str, se: int, ep: int) -> tuple[int, int]:
    """Correct stale/default browser episode values using the title's actual resource seasons."""
    try:
        detail = await _make_request(f"{API_BASE}/detail?detailPath={detail_path}")
        root = detail.get("data", detail)
        subject = root.get("subject", {}) if isinstance(root, dict) else {}
        subject_type = _subject_type(subject)
        seasons = (root.get("resource") or {}).get("seasons", []) if isinstance(root, dict) else []
        if subject_type == 1 or any(int(item.get("se", 1)) == 0 for item in seasons if isinstance(item, dict)):
            return 0, 0
        valid_seasons = [int(item.get("se")) for item in seasons if isinstance(item, dict) and str(item.get("se", "")).isdigit() and int(item.get("se")) > 0]
        if valid_seasons:
            resolved_se = se if se in valid_seasons else min(valid_seasons)
            season = next((item for item in seasons if int(item.get("se", -1)) == resolved_se), {})
            max_ep = int(season.get("maxEp") or 0)
            resolved_ep = ep if ep > 0 and (not max_ep or ep <= max_ep) else 1
            return resolved_se, resolved_ep
    except Exception:
        pass
    return se, ep

@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "reelbox"}


@app.get("/sitemap.xml", response_class=Response)
async def sitemap():
    origin = os.getenv("PUBLIC_URL", "").rstrip("/")
    base = origin or ""
    pages = ["/", "/movies", "/tv-series", "/animation", "/search"]
    body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">" + "".join(f"<url><loc>{base}{page}</loc></url>" for page in pages) + "</urlset>"
    return Response(content=body, media_type="application/xml", headers={"Cache-Control": "public, max-age=300"})


@app.get("/{path:path}")
async def frontend_or_asset(path: str):
    """Serve static assets and browser-managed routes without masking API failures."""
    if path.startswith(("api/", "detail/", "search/", "home/", "movies/", "tv-series/", "animation/")):
        raise HTTPException(status_code=404, detail="Not found")
    requested = (STATIC_DIR / path).resolve()
    if STATIC_DIR.resolve() in requested.parents and requested.is_file():
        media_type = None
        if requested.suffix == ".css": media_type = "text/css"
        elif requested.suffix == ".js": media_type = "text/javascript"
        elif requested.suffix == ".svg": media_type = "image/svg+xml"
        elif requested.suffix == ".webmanifest": media_type = "application/manifest+json"
        elif requested.suffix == ".json": media_type = "application/json"
        elif requested.suffix == ".txt": media_type = "text/plain"
        return FileResponse(requested, media_type=media_type, headers={"Cache-Control": "no-cache" if requested.name in {"index.html", "manus-routes.json", "robots.txt"} else "public, max-age=31536000, immutable"})
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "3000")), reload=False)
