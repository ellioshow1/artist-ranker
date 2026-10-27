// Spotify Web API access: PKCE login, rate-limit-aware fetch, catalog scan, playlist export.

import { DEFAULT_CLIENT_ID } from './config.js';

const SCOPES = 'playlist-modify-private playlist-modify-public user-read-private';
const AUTH_KEY = 'artistRanker.auth';
const VERIFIER_KEY = 'artistRanker.pkce';

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function loadAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || {}; } catch { return {}; }
}
function saveAuth(a) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch {}
}

export function getClientId() { return loadAuth().clientId || DEFAULT_CLIENT_ID; }
export const sharedClientId = DEFAULT_CLIENT_ID;
export function isLoggedIn() { return !!loadAuth().refreshToken; }
export function logout() { const a = loadAuth(); saveAuth({ clientId: a.clientId }); }

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startLogin(clientId) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));
  saveAuth({ ...loadAuth(), clientId });
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + p;
}

// Call on page load. Returns true if a login redirect was just completed.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', redirectUri());
  if (q.has('error')) throw new Error('Spotify login was cancelled: ' + q.get('error'));
  const saved = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) || '{}');
  if (!saved.verifier || saved.state !== q.get('state')) throw new Error('Login state mismatch, please try again.');
  const a = loadAuth();
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: redirectUri(),
    client_id: a.clientId,
    code_verifier: saved.verifier,
  });
  sessionStorage.removeItem(VERIFIER_KEY);
  storeToken(tok);
  return true;
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Spotify token error: ' + (body.error_description || body.error || res.status));
  return body;
}

function storeToken(tok) {
  const a = loadAuth();
  a.accessToken = tok.access_token;
  a.expiresAt = Date.now() + (tok.expires_in - 60) * 1000;
  if (tok.refresh_token) a.refreshToken = tok.refresh_token;
  saveAuth(a);
}

let refreshing = null;
async function accessToken() {
  const a = loadAuth();
  if (a.accessToken && Date.now() < a.expiresAt) return a.accessToken;
  if (!a.refreshToken) throw new Error('Not logged in to Spotify.');
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: a.clientId })
    .then(storeToken)
    .finally(() => { refreshing = null; });
  await refreshing;
  return loadAuth().accessToken;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function api(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + await accessToken(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 8) {
      await sleep((Number(res.headers.get('Retry-After')) || 2 ** attempt) * 1000 + 250);
      continue;
    }
    if (res.status === 401 && attempt < 1) { saveAuth({ ...loadAuth(), expiresAt: 0 }); continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || res.statusText;
      const err = new Error(res.status === 403 && /regist/i.test(msg)
        ? "Spotify says this account isn't allowed to use this app yet. Ask whoever shared it to add your Spotify email under User Management in their developer dashboard, or log out and use your own Client ID."
        : `Spotify ${res.status}: ${msg} (${path})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

async function pageAll(path, limit) {
  const out = [];
  let next = path + (path.includes('?') ? '&' : '?') + 'limit=' + limit;
  while (next) {
    const page = await api(next);
    out.push(...page.items);
    next = page.next;
  }
  return out;
}

// Dev-mode apps have had page limits cut before, so fall back to smaller pages if 50 is rejected.
async function pageAllSafe(path) {
  try { return await pageAll(path, 50); }
  catch (e) { if (e.status === 400) return pageAll(path, 10); throw e; }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

function toTrack(t, album, group) {
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.map(a => ({ id: a.id, name: a.name })),
    duration: t.duration_ms,
    explicit: !!t.explicit,
    album: {
      id: album.id,
      name: album.name,
      type: album.album_type,
      group,
      date: album.release_date || '',
      image: album.images?.[1]?.url || album.images?.[0]?.url || '',
      imageSmall: album.images?.[album.images.length - 1]?.url || '',
    },
  };
}

export async function searchArtists(q) {
  const r = await api(`/search?type=artist&limit=10&q=${encodeURIComponent(q)}`);
  return r.artists.items.map(artistInfo);
}

export async function getArtist(id) {
  return artistInfo(await api(`/artists/${id}`));
}

function artistInfo(a) {
  return {
    id: a.id,
    name: a.name,
    image: a.images?.[1]?.url || a.images?.[0]?.url || '',
    genres: a.genres || [],
  };
}

// Every track (raw, not yet deduped) the artist is credited on.
export async function fetchCatalog(artistId, onProgress = () => {}) {
  const groups = ['album', 'single', 'appears_on', 'compilation'];
  const albums = new Map();
  for (const g of groups) {
    onProgress({ phase: 'releases', text: `Finding ${g.replace('_', ' ')} releases…` });
    const items = await pageAllSafe(`/artists/${artistId}/albums?include_groups=${g}&market=from_token`);
    for (const a of items) if (!albums.has(a.id)) albums.set(a.id, { album: a, group: g });
  }
  const list = [...albums.values()];
  const tracks = [];
  let done = 0;
  await pool(list, 4, async ({ album, group }) => {
    const items = await pageAllSafe(`/albums/${album.id}/tracks?market=from_token`);
    for (const t of items) {
      if (t.id && t.artists.some(a => a.id === artistId)) tracks.push(toTrack(t, album, group));
    }
    done++;
    onProgress({ phase: 'tracks', done, total: list.length, found: tracks.length, text: album.name });
  });
  return tracks;
}

export async function fetchTrack(id) {
  const t = await api(`/tracks/${id}?market=from_token`);
  return toTrack(t, t.album, 'manual');
}

// Creates (or overwrites) a playlist with the given track URIs in order.
export async function savePlaylist({ playlistId, name, description, uris }) {
  let id = playlistId;
  if (id) {
    try { await api(`/playlists/${id}`, { method: 'PUT', body: { name, description } }); }
    catch (e) { if (e.status === 404 || e.status === 403) id = null; else throw e; }
  }
  let url;
  if (!id) {
    const pl = await api('/me/playlists', { method: 'POST', body: { name, description, public: false } });
    id = pl.id;
    url = pl.external_urls?.spotify;
  }
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await api(`/playlists/${id}/items`, {
      method: i === 0 ? 'PUT' : 'POST',
      body: { uris: chunk },
    });
  }
  return { id, url: url || `https://open.spotify.com/playlist/${id}` };
}
