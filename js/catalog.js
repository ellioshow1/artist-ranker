// Turns the raw track scan into one entry per song: merges the same song across
// singles, albums, deluxes and clean versions, and tags alternate versions.

const FEAT = /\s*[\(\[]\s*(feat\.?|ft\.?|featuring|with)\s[^\)\]]*[\)\]]/gi;
const DASH_FEAT = /\s+-\s+(feat\.?|ft\.?|featuring|with)\s.*$/i;

export function normTitle(name) {
  return name
    .replace(FEAT, '')
    .replace(DASH_FEAT, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const VERSION_TAGS = {
  sped: { label: 'Sped up / slowed', re: /\b(sped|speed|slowed|reverb|nightcore|8d)\b/i },
  instrumental: { label: 'Instrumentals / a cappellas', re: /\b(instrumental|acapella|a cappella|a capella)\b/i },
  remix: { label: 'Remixes', re: /\bremix\b/i },
  live: { label: 'Live versions', re: /\blive\b.*\b(from|at|version|session)\b|\(live\)|- live\b/i },
};

export function versionTag(name) {
  for (const [k, v] of Object.entries(VERSION_TAGS)) if (v.re.test(name)) return k;
  return null;
}

const GROUP_RANK = { album: 0, single: 1, manual: 1, compilation: 2, appears_on: 2 };

function better(a, b) {
  // Prefer the album version, explicit, then the earliest release.
  const g = (GROUP_RANK[a.album.group] ?? 3) - (GROUP_RANK[b.album.group] ?? 3);
  if (g) return g < 0;
  if (a.explicit !== b.explicit) return a.explicit;
  return (a.album.date || '9') < (b.album.date || '9');
}

// Returns songs: each is the canonical track plus `alts` (other track ids) and `tag`.
export function buildSongs(rawTracks) {
  const byTitle = new Map();
  for (const t of rawTracks) {
    const k = normTitle(t.name);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(t);
  }
  const songs = [];
  for (const [key, group] of byTitle) {
    group.sort((a, b) => a.duration - b.duration);
    // Same title within 10s of each other = same song; otherwise keep apart (e.g. two different "Intro"s).
    const clusters = [];
    for (const t of group) {
      const c = clusters.find(c => Math.abs(c[0].duration - t.duration) <= 10000);
      c ? c.push(t) : clusters.push([t]);
    }
    for (const c of clusters) {
      let best = c[0];
      for (const t of c) if (better(t, best)) best = t;
      const seen = new Set();
      songs.push({
        ...best,
        key,
        tag: versionTag(best.name),
        alts: c.filter(t => t.id !== best.id && !seen.has(t.id) && seen.add(t.id)).map(t => t.id),
        dupeTitle: clusters.length > 1,
        primary: best.artists[0]?.id,
      });
    }
  }
  songs.sort((a, b) => (b.album.date || '').localeCompare(a.album.date || '') || a.name.localeCompare(b.name));
  return songs;
}

export function artistLine(song) {
  return song.artists.map(a => a.name).join(', ');
}

export function year(song) {
  return (song.album.date || '').slice(0, 4);
}
