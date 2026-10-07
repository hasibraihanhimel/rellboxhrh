const view = document.querySelector('#view');
const searchForm = document.querySelector('.search-form');
const searchInput = document.querySelector('#global-search');
const suggestions = document.querySelector('#suggestions');
const nav = document.querySelector('.main-nav');
const navToggle = document.querySelector('.nav-toggle');
const toastRegion = document.querySelector('#toast-region');

const state = {
  routeId: 0,
  cache: new Map(),
  inflight: new Map(),
  observer: null,
  listContext: null,
  player: null,
  homeRefreshTimer: null,
  suggestionTimer: null,
  suggestionRequest: 0,
  suggestionAbortController: null,
  routeAbortController: null,
  episodeCatalog: [],
};

const CACHE_TTL = {
  home: 90_000,
  catalog: 120_000,
  search: 45_000,
  detail: 300_000,
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function encodePath(value = '') { return encodeURIComponent(value).replace(/%2F/g, '/'); }
function formatTime(seconds = 0) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}
function firstValue(object, keys, fallback = '') {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}
function imageUrl(value) {
  if (!value) return '/reelbox-mark.svg';
  if (typeof value === 'string') return value;
  return value.url || value.src || value.imageUrl || '/reelbox-mark.svg';
}
function unwrap(data) { return data?.data ?? data ?? {}; }
function normalizeItem(raw = {}) {
  const item = raw.subject || raw;
  const cover = item.cover || item.poster || item.image || {};
  return {
    name: firstValue(item, ['name', 'title', 'subjectName'], 'Untitled'),
    poster_url: imageUrl(firstValue(item, ['poster_url', 'posterUrl', 'cover', 'poster', 'image'], cover)),
    backdrop_url: imageUrl(firstValue(item, ['backdrop_url', 'backdropUrl', 'banner', 'background'], cover)),
    slug: firstValue(item, ['slug', 'detailPath', 'detail_path'], ''),
    subject_id: String(firstValue(item, ['subject_id', 'subjectId', 'id'], '')),
    rating: firstValue(item, ['rating', 'imdbRatingValue', 'imdbRating'], ''),
    year: firstValue(item, ['year', 'releaseYear'], firstValue(item, ['releaseDate'], '').slice(0, 4)),
    badge: firstValue(item, ['badge', 'corner'], ''),
    type: firstValue(item, ['type', 'category', 'subjectType'], ''),
  };
}

function notify(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  toastRegion.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function readStored(key) {
  try {
    const raw = localStorage.getItem(`reelbox:${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (Date.now() - value.time > 10 * 60 * 1000) return null;
    return value.data;
  } catch { return null; }
}
function writeStored(key, data) {
  try { localStorage.setItem(`reelbox:${key}`, JSON.stringify({ time: Date.now(), data })); } catch { /* storage is optional */ }
}

async function request(path, { ttl = 0, cacheKey = path, signal } = {}) {
  const now = Date.now();
  const hit = state.cache.get(cacheKey);
  if (hit && now - hit.time < ttl) return hit.data;
  if (!hit && ttl) {
    const stored = readStored(cacheKey);
    if (stored) {
      state.cache.set(cacheKey, { time: now, data: stored });
      return stored;
    }
  }
  const pending = state.inflight.get(cacheKey);
  if (pending && !pending.signal?.aborted) return pending;
  const activeSignal = signal || state.routeAbortController?.signal;
  const controller = new AbortController();
  const abortFromRoute = () => controller.abort();
  if (activeSignal) {
    if (activeSignal.aborted) controller.abort();
    else activeSignal.addEventListener('abort', abortFromRoute, { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  const promise = fetch(path, { signal: controller.signal, headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return response.json();
    })
    .then((data) => {
      state.cache.set(cacheKey, { time: Date.now(), data });
      if (ttl) writeStored(cacheKey, data);
      return data;
    })
    .finally(() => {
      window.clearTimeout(timeout);
      activeSignal?.removeEventListener('abort', abortFromRoute);
      if (state.inflight.get(cacheKey) === promise) state.inflight.delete(cacheKey);
    });
  promise.signal = controller.signal;
  state.inflight.set(cacheKey, promise);
  return promise;
}

function setPageMeta(title, description, image = '') {
  document.title = `${title} · Reelbox`;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.content = description;
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDescription = document.querySelector('meta[property="og:description"]');
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogTitle) ogTitle.content = title;
  if (ogDescription) ogDescription.content = description;
  if (ogImage && image) ogImage.content = image;
}

function showSkeleton(count = 8) {
  return `<div class="card-grid">${Array.from({ length: count }, () => `<article class="poster-card skeleton-card"><div class="poster-link skeleton"></div><div class="skeleton-line skeleton"></div><div class="skeleton-line short skeleton"></div></article>`).join('')}</div>`;
}

function card(item) {
  const normalized = normalizeItem(item);
  if (!normalized.slug && !normalized.subject_id) return '';
  const href = normalized.slug ? `/title/${encodePath(normalized.slug)}` : `/watch/${encodePath(normalized.subject_id)}`;
  return `<article class="poster-card">
    <a class="poster-link" href="${href}" data-link aria-label="Open ${escapeHtml(normalized.name)}">
      <img src="${escapeHtml(normalized.poster_url)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='/reelbox-mark.svg';">
      ${normalized.badge ? `<span class="poster-badge">${escapeHtml(normalized.badge)}</span>` : ''}
      ${normalized.rating ? `<span class="poster-rating">★ ${escapeHtml(normalized.rating)}</span>` : ''}
    </a>
    <a class="card-title" href="${href}" data-link>${escapeHtml(normalized.name)}</a>
    <p class="card-subtitle">${escapeHtml([normalized.year, normalized.type].filter(Boolean).join(' · ') || 'Open details')}</p>
  </article>`;
}

function sectionRail(title, items, href = '') {
  const list = (items || []).map(card).filter(Boolean).join('');
  if (!list) return '';
  return `<section class="section"><div class="section-header"><h2>${escapeHtml(title)}</h2>${href ? `<a href="${href}" data-link>View all →</a>` : ''}</div><div class="rail">${list}</div></section>`;
}

function normalizeHomeSections(data) {
  const rawSections = data?.sections || unwrap(data)?.sections || [];
  return rawSections.map((section) => ({
    title: section.section || section.title || 'Featured',
    items: (section.items || section.subjects || []).map(normalizeItem).filter((item) => item.name),
  })).filter((section) => section.items.length);
}

async function renderHome(routeId) {
  window.clearInterval(state.homeRefreshTimer);
  state.homeRefreshTimer = null;
  setPageMeta('Find your next watch', 'Fresh picks, trending movies, series, and animation in one quick screening room.');
  view.innerHTML = showSkeleton(10);
  try {
    const data = await request('/home', { ttl: CACHE_TTL.home, cacheKey: 'home' });
    if (routeId !== state.routeId) return;
    const sections = normalizeHomeSections(data);
    const bannerSection = sections.find((section) => section.title.toLowerCase() === 'banner') || sections[0];
    const hero = bannerSection?.items?.[0] || sections.flatMap((section) => section.items)[0];
    const rails = sections.filter((section) => section !== bannerSection).slice(0, 8);
    view.innerHTML = `${hero ? `<section class="hero">
      <img class="hero-image" src="${escapeHtml(hero.backdrop_url || hero.poster_url)}" alt="" loading="eager" fetchpriority="high" onerror="this.onerror=null;this.src='${escapeHtml(hero.poster_url)}';">
      <div class="hero-copy">
        <p class="eyebrow">Tonight's screening</p>
        <h1>${escapeHtml(hero.name)}</h1>
        <div class="hero-meta"><strong>● Fresh from the catalog</strong>${hero.rating ? `<span>★ ${escapeHtml(hero.rating)}</span>` : ''}${hero.year ? `<span>${escapeHtml(hero.year)}</span>` : ''}</div>
        <p>Pick a title, settle in, and let Reelbox take you from discovery to play without the wait.</p>
        <div class="hero-actions"><a class="button" href="${hero.slug ? `/title/${encodePath(hero.slug)}` : `/watch/${encodePath(hero.subject_id)}`} data-link>View title <span aria-hidden="true">→</span></a><a class="button secondary" href="/movies" data-link>Browse everything</a></div>
      </div>
    </section>` : ''}${rails.map((section) => sectionRail(section.title, section.items, section.title.toLowerCase().includes('movie') ? '/movies' : '')).join('')}${!sections.length ? `<div class="empty-state"><div><h2>The room is quiet.</h2><p>We couldn't load the current catalog. Try again in a moment.</p><button class="button" data-action="retry-home">Retry</button></div></div>` : ''}`;
    state.homeRefreshTimer = window.setInterval(() => {
      if (location.pathname === '/' && routeId === state.routeId) {
        state.cache.delete('home');
        renderHome(routeId);
      }
    }, 5 * 60 * 1000);
  } catch (error) {
    if (routeId !== state.routeId) return;
    view.innerHTML = `<div class="empty-state error-state"><div><h2>Couldn't load the room.</h2><p>${escapeHtml(error.message)}. The upstream catalog may be waking up.</p><button class="button" data-action="retry-home">Retry</button></div></div>`;
  }
}

function getCategoryTitle(pathname) {
  return pathname === '/movies' ? ['Movies', 'Movie catalog'] : pathname === '/tv-series' ? ['TV Series', 'Long-form stories and returning favorites'] : ['Animation', 'Animated films and series'];
}

async function renderCatalog(pathname, routeId) {
  const [title, subtitle] = getCategoryTitle(pathname);
  let sort = new URLSearchParams(location.search).get('sort') || 'RECOMMEND';
  setPageMeta(`${title} catalog`, `${subtitle}. Browse the latest titles with fast infinite scrolling.`);
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Browse the room</p><h1>${title}</h1><p>${subtitle}. Load more as you scroll, with no full-page refresh.</p></div></div><div class="filter-bar">${[['RECOMMEND','Recommended'],['LATEST','Latest'],['MOST_WATCHED','Most watched'],['IMDB','Top rated']].map(([value, label]) => `<button class="filter-chip ${sort === value ? 'is-active' : ''}" data-sort="${value}">${label}</button>`).join('')}</div><div id="list-content">${showSkeleton(12)}</div><div class="load-more" id="load-more"></div>`;
  const context = { routeId, pathname, sort, page: 0, total: Infinity, loading: false, done: false };
  state.listContext = context;
  attachInfiniteObserver();
  await loadNextCatalogPage(context);
}

async function loadNextCatalogPage(context) {
  if (!context || context.loading || context.done || context.routeId !== state.routeId) return;
  context.loading = true;
  const nextPage = context.page + 1;
  const endpoint = `${context.pathname}?page=${nextPage}&sort=${encodeURIComponent(context.sort)}`;
  const cacheKey = `catalog:${context.pathname}:${context.sort}:${nextPage}`;
  const loading = document.querySelector('#load-more');
  if (loading && nextPage > 1) loading.innerHTML = '<span class="spinner"></span>Loading more';
  try {
    const data = await request(endpoint, { ttl: CACHE_TTL.catalog, cacheKey });
    if (context.routeId !== state.routeId) return;
    const items = (data.items || unwrap(data).items || []).map(normalizeItem);
    context.page = nextPage;
    context.total = Number(data.total ?? unwrap(data).total ?? 0) || context.total;
    const content = document.querySelector('#list-content');
    if (nextPage === 1) content.innerHTML = items.length ? `<div class="card-grid">${items.map(card).join('')}</div>` : `<div class="empty-state"><div><h2>No titles here yet.</h2><p>Try another sort or check back soon.</p></div></div>`;
    else if (items.length) content.querySelector('.card-grid')?.insertAdjacentHTML('beforeend', items.map(card).join(''));
    if (!items.length || (context.total !== Infinity && context.page * (Number(data.per_page) || items.length) >= context.total)) {
      context.done = true;
      if (loading) loading.textContent = items.length ? 'You reached the end of the catalog.' : '';
    } else if (loading) loading.innerHTML = '<span>Keep scrolling for more</span>';
  } catch (error) {
    if (context.routeId !== state.routeId) return;
    if (loading) loading.innerHTML = `<button class="button secondary small" data-action="retry-list">Retry loading</button>`;
    notify(error.message, 'error');
  } finally {
    context.loading = false;
  }
}

function attachInfiniteObserver() {
  state.observer?.disconnect();
  const sentinel = document.querySelector('#load-more');
  if (!sentinel) return;
  state.observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadNextCatalogPage(state.listContext);
  }, { rootMargin: '700px 0px' });
  state.observer.observe(sentinel);
}

function normalizeSearch(data) {
  return (data.items || unwrap(data).items || data.list || []).map(normalizeItem);
}

async function renderSearch(routeId, initialQuery) {
  const query = (initialQuery || '').trim();
  setPageMeta(query ? `Search results for ${query}` : 'Search the catalog', query ? `Search results for ${query} in Reelbox.` : 'Search movies, series, and animation in Reelbox.');
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Search the catalog</p><h1>${query ? `Results for “${escapeHtml(query)}”` : 'What are you in the mood for?'}</h1><p>${query ? 'Scroll to keep exploring. Results load only when you need them.' : 'Use the search field above to find a film, show, or character.'}</p></div></div><div id="list-content">${query ? showSkeleton(8) : `<div class="empty-state"><div><h2>Start with a title, genre, or mood.</h2><p>Search is debounced and suggestions appear as you type.</p></div></div>`}</div><div class="load-more" id="load-more"></div>`;
  if (!query) return;
  const context = { routeId, query, page: 0, total: Infinity, loading: false, done: false };
  state.listContext = context;
  attachInfiniteObserver();
  await loadNextSearchPage(context);
}

async function loadNextSearchPage(context) {
  if (!context || context.loading || context.done || context.routeId !== state.routeId) return;
  context.loading = true;
  const nextPage = context.page + 1;
  const endpoint = `/search?q=${encodeURIComponent(context.query)}&page=${nextPage}`;
  const loading = document.querySelector('#load-more');
  if (loading && nextPage > 1) loading.innerHTML = '<span class="spinner"></span>Searching more';
  try {
    const data = await request(endpoint, { ttl: CACHE_TTL.search, cacheKey: `search:${context.query}:${nextPage}` });
    if (context.routeId !== state.routeId) return;
    const items = normalizeSearch(data);
    context.page = nextPage;
    context.total = Number(data.total ?? unwrap(data).total ?? 0) || context.total;
    const content = document.querySelector('#list-content');
    if (nextPage === 1) content.innerHTML = items.length ? `<div class="card-grid">${items.map(card).join('')}</div>` : `<div class="empty-state"><div><h2>No match found.</h2><p>Try a shorter title or a different spelling.</p></div></div>`;
    else if (items.length) content.querySelector('.card-grid')?.insertAdjacentHTML('beforeend', items.map(card).join(''));
    if (!items.length || (context.total !== Infinity && context.page * (Number(data.per_page) || items.length) >= context.total)) {
      context.done = true;
      if (loading) loading.textContent = items.length ? 'You reached the end of the results.' : '';
    } else if (loading) loading.innerHTML = '<span>Keep scrolling for more</span>';
  } catch (error) {
    if (context.routeId !== state.routeId) return;
    if (loading) loading.innerHTML = `<button class="button secondary small" data-action="retry-list">Retry loading</button>`;
    notify(error.message, 'error');
  } finally { context.loading = false; }
}

function extractDetail(data) {
  const root = unwrap(data);
  const subject = root.subject || root.detail || root.item || root;
  const item = normalizeItem(subject);
  const synopsis = firstValue(subject, ['description', 'synopsis', 'intro', 'plot', 'story'], 'No synopsis available yet.');
  const genres = firstValue(subject, ['genres', 'genreList', 'genre'], []);
  const genreList = Array.isArray(genres) ? genres.map((genre) => typeof genre === 'string' ? genre : firstValue(genre, ['name', 'title'], '')).filter(Boolean) : String(genres || '').split(',').map((value) => value.trim()).filter(Boolean);
  const episodesRaw = root.episodes || root.episodeList || subject.episodes || subject.episodeList || [];
  const resourceSeasons = root.resource?.seasons || subject.resource?.seasons || [];
  const episodes = Array.isArray(episodesRaw) ? episodesRaw.map((episode, index) => ({
    ep: Number(firstValue(episode, ['ep', 'episode', 'episodeNumber', 'number'], index + 1)),
    se: Number(firstValue(episode, ['se', 'season', 'seasonNumber'], 1)),
    title: firstValue(episode, ['title', 'name'], `Episode ${index + 1}`),
  })) : [];
  const seasonsRaw = root.seasons || subject.seasons || [];
  const seasons = Array.isArray(seasonsRaw) ? seasonsRaw.flatMap((season, seasonIndex) => (season.episodes || season.episodeList || []).map((episode, index) => ({
    ep: Number(firstValue(episode, ['ep', 'episode', 'episodeNumber', 'number'], index + 1)),
    se: Number(firstValue(episode, ['se', 'season', 'seasonNumber'], seasonIndex + 1)),
    title: firstValue(episode, ['title', 'name'], `Episode ${index + 1}`),
  }))) : [];
  const resourceEpisodes = Array.isArray(resourceSeasons) ? resourceSeasons.flatMap((season, seasonIndex) => {
    const seasonNumber = Number(firstValue(season, ['se', 'season', 'seasonNumber'], seasonIndex + 1));
    if (seasonNumber === 0) return [];
    const maxEp = Number(firstValue(season, ['maxEp', 'episodeCount'], 0)) || Math.max(0, ...(season.resolutions || []).map((entry) => Number(entry.epNum) || 0));
    return Array.from({ length: maxEp }, (_, index) => ({ ep: index + 1, se: seasonNumber, title: `Episode ${index + 1}` }));
  }) : [];
  const defaultSe = Array.isArray(resourceSeasons) && resourceSeasons.length ? Number(firstValue(resourceSeasons[0], ['se', 'season', 'seasonNumber'], 1)) : 1;
  const defaultEp = defaultSe === 0 ? 0 : 1;
  const audioOptions = (subject.dubs || root.dubs || []).map((dub) => ({
    label: firstValue(dub, ['lanName', 'languageName', 'name'], 'Audio'),
    language: firstValue(dub, ['lanCode', 'language', 'lang'], ''),
    subjectId: dub.subjectId || dub.subject_id,
    slug: dub.detailPath || dub.detail_path,
  })).filter((dub) => dub.subjectId && dub.slug);
  return {
    ...item,
    description: synopsis,
    genres: genreList,
    duration: firstValue(subject, ['duration', 'runtime'], ''),
    country: firstValue(subject, ['country', 'countryName'], ''),
    languages: firstValue(subject, ['languages', 'audioLanguages', 'languageList'], []),
    episodes: episodes.length ? episodes : (seasons.length ? seasons : resourceEpisodes),
    defaultSe,
    defaultEp,
    audioOptions,
    raw: data,
  };
}

function seasonList(episodes = []) {
  return [...new Set(episodes.map((episode) => Number(episode.se) || 1))].sort((a, b) => a - b);
}

function seasonOptions(episodes = [], selectedSeason = 1) {
  const seasons = seasonList(episodes);
  if (seasons.length < 2) return '';
  return `<label class="season-picker"><span>Season</span><select data-season-select aria-label="Select season">${seasons.map((season) => `<option value="${season}" ${season === Number(selectedSeason) ? 'selected' : ''}>Season ${season}</option>`).join('')}</select></label>`;
}

function episodeButtons(episodes = [], selectedSeason = 1, subjectId = '', slug = '', activeEp = 1) {
  return episodes.filter((episode) => Number(episode.se) === Number(selectedSeason)).slice(0, 100).map((episode) => `<a class="episode-button ${episode.ep === Number(activeEp) ? 'is-active' : ''}" href="/watch/${encodePath(subjectId)}?slug=${encodeURIComponent(slug)}&se=${episode.se}&ep=${episode.ep}" data-link>S${episode.se} E${episode.ep}</a>`).join('');
}

async function renderDetail(slug, routeId) {
  view.innerHTML = showSkeleton(1);
  try {
    const data = await request(`/detail/${encodePath(slug)}`, { ttl: CACHE_TTL.detail, cacheKey: `detail:${slug}` });
    if (routeId !== state.routeId) return;
    const item = extractDetail(data);
    state.episodeCatalog = item.episodes;
    setPageMeta(item.name, item.description, item.poster_url);
    const watchUrl = item.subject_id ? `/watch/${encodePath(item.subject_id)}?slug=${encodeURIComponent(item.slug || slug)}&se=${item.defaultSe ?? 1}&ep=${item.defaultEp ?? 1}` : '';
    view.innerHTML = `<a class="back-link" href="/" data-link>← Back to the room</a><div class="detail-layout"><div class="detail-poster"><img src="${escapeHtml(item.poster_url)}" alt="Poster for ${escapeHtml(item.name)}" loading="eager" onerror="this.onerror=null;this.src='/reelbox-mark.svg';"></div><div class="detail-copy"><p class="eyebrow">${escapeHtml(item.type || 'Title details')}</p><h1>${escapeHtml(item.name)}</h1><div class="meta-row">${item.rating ? `<span class="rating">★ ${escapeHtml(item.rating)}</span>` : ''}${item.year ? `<span>${escapeHtml(item.year)}</span>` : ''}${item.duration ? `<span>${escapeHtml(item.duration)}</span>` : ''}${item.country ? `<span>${escapeHtml(item.country)}</span>` : ''}</div><p class="synopsis">${escapeHtml(item.description)}</p><div class="detail-tags">${item.genres.map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join('')}${Array.isArray(item.languages) ? item.languages.slice(0, 4).map((language) => `<span class="tag">${escapeHtml(typeof language === 'string' ? language : firstValue(language, ['name', 'lang'], 'Audio'))}</span>`).join('') : ''}</div><div class="hero-actions">${watchUrl ? `<a class="button" href="${watchUrl}" data-link>▶ Watch now</a>` : '<span class="tag">Stream information unavailable</span>'}<a class="button secondary" href="/search?q=${encodeURIComponent(item.name)}" data-link>More like this</a></div></div></div>${item.episodes.length ? `<section class="episode-panel"><div class="episode-panel-header"><h2>Episodes</h2>${seasonOptions(item.episodes, item.defaultSe ?? 1)}</div><div class="episode-tools" id="detail-episode-tools" data-subject-id="${escapeHtml(item.subject_id)}" data-slug="${escapeHtml(item.slug || slug)}" data-active-ep="1">${episodeButtons(item.episodes, item.defaultSe ?? 1, item.subject_id, item.slug || slug, 1)}</div></section>` : ''}`;
  } catch (error) {
    if (routeId !== state.routeId) return;
    view.innerHTML = `<div class="empty-state error-state"><div><h2>Title unavailable.</h2><p>${escapeHtml(error.message)}. Try going back and opening it again.</p><a class="button" href="/" data-link>Return home</a></div></div>`;
  }
}

function streamOptions(streamData) {
  const sources = [];
  const add = (source, kind = 'MP4') => {
    if (!source) return;
    const item = typeof source === 'string' ? { url: source } : source;
    const proxyUrl = item.playback_url || item.proxy_url || '';
    const directUrl = item.direct_url || item.url || item.src || item.playUrl || item.play_url || '';
    const url = proxyUrl || directUrl;
    if (!url || sources.some((existing) => existing.url === url)) return;
    const nestedAudio = item.audio || item.audioTrack || {};
    sources.push({ url, fallbackUrl: proxyUrl && directUrl && proxyUrl !== directUrl ? directUrl : '', isDirect: !proxyUrl, kind: item.format || item.type || kind, resolution: item.resolution || item.resolutions || item.quality || '', language: item.language || item.lang || item.audioLanguage || item.audio_lang || item.languageName || nestedAudio.language || nestedAudio.lang || '' });
  };
  (streamData.sources || []).forEach((source) => add(source, 'MP4'));
  (streamData.hls || []).forEach((source) => add(source, 'HLS'));
  (streamData.dash || []).forEach((source) => add(source, 'DASH'));
  return sources.sort((a, b) => {
    const kindWeight = (value) => value === 'MP4' ? 0 : 1;
    return kindWeight(a.kind) - kindWeight(b.kind) || Number.parseInt(b.resolution, 10) - Number.parseInt(a.resolution, 10);
  });
}

function captionOptions(data) {
  return (data?.captions || []).map((caption, index) => {
    const item = typeof caption === 'string' ? { url: caption } : caption;
    const language = item.language || item.lang || item.lan || item.languageName || item.lanName || `Subtitle ${index + 1}`;
    return { url: item.url || item.src || item.captionUrl || item.caption_url || '', language, label: item.label || item.name || item.language || item.lang || item.lanName || item.lan || `Subtitle ${index + 1}` };
  }).filter((caption) => caption.url);
}

function playerTemplate(item, subjectId, slug, se, ep, episodes = []) {
  return `<section class="watch-shell"><a class="back-link" href="${slug ? `/title/${encodePath(slug)}` : '/'}" data-link>← Back to details</a><div class="player-wrap"><div class="video-frame is-loading" id="video-frame"><video id="watch-video" playsinline preload="metadata"></video><div class="player-overlay"><div class="loading-player">Finding the fastest available stream…</div></div><div class="controls"><input class="progress" id="video-progress" type="range" min="0" max="100" value="0" step="0.1" aria-label="Video progress"><button class="control-button" id="play-toggle" type="button" aria-label="Play or pause">▶</button><button class="control-button" id="skip-back" type="button" aria-label="Back 10 seconds">↶</button><span class="time-label" id="time-label">00:00 / 00:00</span><select class="player-select" id="quality-select" aria-label="Video quality"><option>Quality</option></select><select class="player-select" id="caption-select" aria-label="Subtitles"><option>Subtitles</option></select><select class="player-select" id="audio-select" aria-label="Audio language"><option>Audio · source default</option></select><button class="control-button" id="mute-toggle" type="button" aria-label="Mute">⌕</button><button class="control-button" id="pip-toggle" type="button" aria-label="Picture in picture">▣</button><button class="control-button" id="fullscreen-toggle" type="button" aria-label="Fullscreen">⛶</button></div></div></div><div class="player-meta"><div><p class="eyebrow">Now screening</p><h1>${escapeHtml(item.name || 'Untitled')}</h1><p class="player-note" id="player-note">Loading playback options…</p></div><div class="episode-panel-inline">${seasonOptions(episodes, se)}<div class="episode-tools" id="episode-tools" data-subject-id="${escapeHtml(subjectId)}" data-slug="${escapeHtml(slug)}" data-active-ep="${ep}">${episodeButtons(episodes, se, subjectId, slug, ep)}</div></div></div></section>`;
}

function setSelectOptions(select, options, placeholder) {
  if (!select) return;
  select.innerHTML = `<option value="">${placeholder}</option>${options.map((option, index) => `<option value="${index}">${escapeHtml(option.label)}</option>`).join('')}`;
  select.disabled = !options.length;
}

function setupPlayer(streamData, captionsData, item, subjectId, slug, se, ep) {
  const video = document.querySelector('#watch-video');
  const frame = document.querySelector('#video-frame');
  const progress = document.querySelector('#video-progress');
  const playToggle = document.querySelector('#play-toggle');
  const timeLabel = document.querySelector('#time-label');
  const quality = document.querySelector('#quality-select');
  const caption = document.querySelector('#caption-select');
  const audio = document.querySelector('#audio-select');
  const note = document.querySelector('#player-note');
  const sources = streamOptions(streamData);
  const captionList = captionOptions(captionsData);
  const declaredAudio = Array.isArray(streamData.audio) ? streamData.audio : Array.isArray(streamData.audio_tracks) ? streamData.audio_tracks : [];
  const dubbedAudio = Array.isArray(item.audioOptions) ? item.audioOptions : [];
  const audioList = [...new Map([...dubbedAudio.map((option) => [option.subjectId, option]), ...sources.filter((source) => source.language).map((source) => [source.language, { label: source.language, language: source.language }]), ...declaredAudio.map((track, index) => {
    const value = typeof track === 'string' ? track : track.language || track.lang || track.name || track.label;
    return value ? [value, { label: value, language: value, index }] : [`track-${index}`, null];
  }).filter(([, value]) => value)]).values()];
  setSelectOptions(quality, sources.map((source) => ({ label: `${source.resolution ? `${source.resolution} · ` : ''}${source.kind}`, ...source })), 'Quality');
  setSelectOptions(caption, captionList.map((option) => ({ label: option.label, ...option })), 'Subtitles');
  setSelectOptions(audio, audioList, audioList.length ? 'Audio language' : 'Audio · source default');
  if (!sources.length) {
    frame.classList.remove('is-loading');
    const comingSoon = streamData.coming_soon !== false;
    note.innerHTML = comingSoon
      ? '<span class="coming-soon-badge">Coming soon</span> This title has not been uploaded for streaming yet.'
      : escapeHtml(streamData.note || 'No playable stream was returned for this episode.');
    notify(comingSoon ? 'This title is coming soon.' : 'No playable source is available.', comingSoon ? 'info' : 'error');
    state.player = { video, sources: [], item };
    return;
  }
  note.textContent = `${sources.length} quality option${sources.length === 1 ? '' : 's'} available · subtitles and audio depend on the source`;
  let currentIndex = 0;
  const failedSources = new Set();
  let activeTrack = null;
  let timeUpdateFrame = 0;
  const syncTime = () => {
    timeUpdateFrame = 0;
    progress.value = video.duration ? String((video.currentTime / video.duration) * 100) : '0';
    timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  };
  const switchSource = async (index, preserveTime = true) => {
    const next = sources[index];
    if (!next) return;
    const currentTime = preserveTime ? video.currentTime : 0;
    const wasPlaying = !video.paused;
    currentIndex = index;
    failedSources.delete(index);
    frame.classList.add('is-loading');
    video.src = next.url;
    video.load();
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(currentTime) && currentTime > 0) video.currentTime = Math.min(currentTime, video.duration || currentTime);
      frame.classList.remove('is-loading');
      if (wasPlaying) video.play().catch(() => notify('Press play to resume this source.'));
    }, { once: true });
    quality.value = String(index);
  };
  const setCaption = (index) => {
    if (activeTrack) activeTrack.remove();
    activeTrack = null;
    if (!captionList[index]) return;
    activeTrack = document.createElement('track');
    activeTrack.kind = 'subtitles';
    activeTrack.label = captionList[index].label;
    activeTrack.srclang = String(captionList[index].language || 'en').slice(0, 2).toLowerCase();
    activeTrack.src = captionList[index].url;
    activeTrack.default = true;
    video.append(activeTrack);
    activeTrack.addEventListener('load', () => { if (activeTrack?.track) activeTrack.track.mode = 'showing'; });
  };
  quality.addEventListener('change', () => switchSource(Number(quality.value)));
  caption.addEventListener('change', () => setCaption(Number(caption.value)));
  audio.addEventListener('change', () => {
    const selected = audioList[Number(audio.value)];
    if (!selected) return;
    if (selected.subjectId && selected.slug) {
      navigate(`/watch/${encodePath(selected.subjectId)}?slug=${encodeURIComponent(selected.slug)}&se=${se}&ep=${ep}`);
      return;
    }
    const index = sources.findIndex((source) => source.language === selected.language);
    if (index >= 0) switchSource(index);
    else if (video.audioTracks) {
      [...video.audioTracks].forEach((track) => { track.enabled = track.language === selected.language; });
    }
  });
  const togglePlay = () => video.paused ? video.play().catch(() => notify('This source needs a tap to start.')) : video.pause();
  playToggle.addEventListener('click', togglePlay);
  video.addEventListener('play', () => { playToggle.textContent = '❚❚'; playToggle.setAttribute('aria-label', 'Pause'); });
  video.addEventListener('pause', () => { playToggle.textContent = '▶'; playToggle.setAttribute('aria-label', 'Play'); });
  video.addEventListener('timeupdate', () => { if (!timeUpdateFrame) timeUpdateFrame = requestAnimationFrame(syncTime); });
  video.addEventListener('loadedmetadata', () => { frame.classList.remove('is-loading'); timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`; });
  video.addEventListener('waiting', () => frame.classList.add('is-loading'));
  video.addEventListener('playing', () => frame.classList.remove('is-loading'));
  video.addEventListener('error', () => {
    frame.classList.remove('is-loading');
    const current = sources[currentIndex];
    if (current?.fallbackUrl) {
      current.url = current.fallbackUrl;
      current.fallbackUrl = '';
      current.isDirect = true;
      note.textContent = 'The server proxy was rejected. Trying the direct source…';
      switchSource(currentIndex, true);
      return;
    }
    failedSources.add(currentIndex);
    const fallbackIndex = [...sources.keys()].find((index) => !failedSources.has(index));
    if (fallbackIndex !== undefined) {
      note.textContent = 'That source was unavailable. Trying another quality…';
      switchSource(fallbackIndex, true);
      return;
    }
    note.textContent = 'None of the available sources could be played. Try another title or episode.';
    notify('Playback failed for every available source.', 'error');
  });
  progress.addEventListener('input', () => { if (video.duration) video.currentTime = (Number(progress.value) / 100) * video.duration; });
  document.querySelector('#skip-back').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  document.querySelector('#mute-toggle').addEventListener('click', (event) => { video.muted = !video.muted; event.currentTarget.textContent = video.muted ? '🔇' : '⌕'; });
  document.querySelector('#pip-toggle').addEventListener('click', async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else if (document.pictureInPictureEnabled) await video.requestPictureInPicture(); } catch { notify('Picture-in-picture is not available in this browser.'); } });
  document.querySelector('#fullscreen-toggle').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.player-wrap').requestFullscreen(); } catch { notify('Fullscreen is not available in this browser.'); } });
  state.player = { video, sources, item, currentIndex, switchSource };
  switchSource(Math.max(0, sources.length - 1), false);
}

async function renderWatch(subjectId, params, routeId) {
  const slug = params.get('slug') || '';
  let se = Number(params.get('se') || 1);
  let ep = Number(params.get('ep') || 1);
  let item = { name: 'Reelbox player', slug, subject_id: subjectId, poster_url: '/reelbox-mark.svg', episodes: [] };
  let detail = null;
  view.innerHTML = playerTemplate(item, subjectId, slug, se, ep);
  try {
    if (slug) {
      detail = await request(`/detail/${encodePath(slug)}`, { ttl: CACHE_TTL.detail, cacheKey: `detail:${slug}` });
      item = extractDetail(detail);
      state.episodeCatalog = item.episodes;
      if (!params.has('se')) se = item.defaultSe ?? se;
      if (!params.has('ep')) ep = item.defaultEp ?? ep;
      if (routeId !== state.routeId) return;
      view.querySelector('.player-meta h1').textContent = item.name;
      view.querySelector('.back-link').href = `/title/${encodePath(slug)}`;
      const episodeTools = view.querySelector('#episode-tools');
      if (episodeTools) {
        episodeTools.dataset.subjectId = subjectId;
        episodeTools.dataset.slug = slug;
        episodeTools.dataset.activeEp = String(ep);
        episodeTools.innerHTML = episodeButtons(item.episodes, se, subjectId, slug, ep);
      }
      const seasonSelect = view.querySelector('[data-season-select]');
      if (seasonSelect) seasonSelect.value = String(se);
      setPageMeta(item.name, item.description, item.poster_url);
    }
    const [streamData, captionsData] = await Promise.all([
      request(`/api/stream/${encodePath(subjectId)}?detail_path=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`, { ttl: 25_000, cacheKey: `stream:v2:${subjectId}:${slug}:${se}:${ep}` }),
      request(`/api/stream/${encodePath(subjectId)}/captions?detail_path=${encodeURIComponent(slug)}&se=${se}&ep=${ep}`, { ttl: 120_000, cacheKey: `captions:v2:${subjectId}:${slug}:${se}:${ep}` }).catch(() => ({ captions: [] })),
    ]);
    if (routeId !== state.routeId) return;
    setupPlayer(streamData, captionsData, item, subjectId, slug, se, ep);
  } catch (error) {
    if (routeId !== state.routeId) return;
    const note = document.querySelector('#player-note');
    if (note) note.textContent = `Playback setup failed: ${error.message}`;
    document.querySelector('#video-frame')?.classList.remove('is-loading');
    notify('Playback setup failed. Try again or choose another title.', 'error');
  }
}

async function renderRoute() {
  state.routeAbortController?.abort();
  state.routeAbortController = new AbortController();
  state.routeId += 1;
  const routeId = state.routeId;
  window.clearInterval(state.homeRefreshTimer);
  state.homeRefreshTimer = null;
  state.observer?.disconnect();
  state.listContext = null;
  state.player = null;
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  const parts = pathname.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach((link) => link.classList.toggle('is-active', link.dataset.nav === (pathname === '/' ? 'home' : parts[0])));
  nav.classList.remove('is-open');
  if (pathname === '/') return renderHome(routeId);
  if (['/movies', '/tv-series', '/animation'].includes(pathname)) return renderCatalog(pathname, routeId);
  if (pathname === '/search') return renderSearch(routeId, new URLSearchParams(location.search).get('q') || '');
  if (parts[0] === 'title' && parts[1]) return renderDetail(decodeURIComponent(parts.slice(1).join('/')), routeId);
  if (parts[0] === 'watch' && parts[1]) return renderWatch(decodeURIComponent(parts[1]), new URLSearchParams(location.search), routeId);
  view.innerHTML = `<div class="empty-state"><div><h2>That page moved.</h2><p>Return to the room and choose another title.</p><a class="button" href="/" data-link>Go home</a></div></div>`;
}

function navigate(url) {
  if (url === location.pathname + location.search) return;
  history.pushState({}, '', url);
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (link && link.origin === location.origin) { event.preventDefault(); navigate(link.pathname + link.search); }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry-home') renderRoute();
  if (action === 'retry-list' && state.listContext) {
    state.listContext.loading = false;
    state.listContext.done = false;
    loadNextCatalogPage(state.listContext);
  }
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  suggestions.hidden = true;
  if (query) navigate(`/search?q=${encodeURIComponent(query)}`);
});

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();
  window.clearTimeout(state.suggestionTimer);
  state.suggestionAbortController?.abort();
  state.suggestionAbortController = null;
  if (query.length < 2) { suggestions.hidden = true; return; }
  state.suggestionTimer = window.setTimeout(async () => {
    const requestId = ++state.suggestionRequest;
    state.suggestionAbortController = new AbortController();
    try {
      const data = await request(`/search/suggest?q=${encodeURIComponent(query)}`, { ttl: 30_000, cacheKey: `suggest:${query}`, signal: state.suggestionAbortController.signal });
      if (requestId !== state.suggestionRequest) return;
      const list = (data.suggestions || []).slice(0, 8);
      suggestions.innerHTML = list.length ? list.map((item) => `<a class="suggestion" href="${item.slug ? `/title/${encodePath(item.slug)}` : `/search?q=${encodeURIComponent(item.title || query)}`}" data-link><span class="suggestion-icon">⌕</span><span>${escapeHtml(item.title || query)}</span></a>`).join('') : '<div class="suggestion">No quick matches yet</div>';
      suggestions.hidden = false;
    } catch { suggestions.hidden = true; }
  }, 220);
});

searchInput.addEventListener('focus', () => { if (suggestions.innerHTML && searchInput.value.trim().length >= 2) suggestions.hidden = false; });
document.addEventListener('click', (event) => { if (!event.target.closest('.search-form')) suggestions.hidden = true; });
navToggle.addEventListener('click', () => { const open = nav.classList.toggle('is-open'); navToggle.setAttribute('aria-expanded', String(open)); });

document.addEventListener('click', (event) => {
  const sort = event.target.closest('[data-sort]')?.dataset.sort;
  if (sort && state.listContext) {
    const context = state.listContext;
    const url = `${context.pathname}?sort=${encodeURIComponent(sort)}`;
    navigate(url);
  }
});

document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-season-select]');
  if (!select) return;
  const tools = select.closest('.episode-panel, .episode-panel-inline')?.querySelector('.episode-tools');
  if (!tools) return;
  const season = Number(select.value) || 1;
  const activeEp = Number(tools.dataset.activeEp) || 1;
  tools.innerHTML = episodeButtons(state.episodeCatalog, season, tools.dataset.subjectId, tools.dataset.slug, activeEp);
  tools.dataset.activeEp = String(activeEp);
});

document.addEventListener('keydown', (event) => {
  if (!state.player?.video || event.target.matches('input,select,textarea')) return;
  const video = state.player.video;
  if (event.key === ' ') { event.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
  if (event.key === 'ArrowRight') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  if (event.key.toLowerCase() === 'f') document.querySelector('#fullscreen-toggle')?.click();
  if (event.key.toLowerCase() === 'm') document.querySelector('#mute-toggle')?.click();
});

window.addEventListener('popstate', renderRoute);
renderRoute();
