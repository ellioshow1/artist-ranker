// Tournament engine. Pure state + functions so it can be saved, undone and tested.
//
// Stage 1, Swiss rounds: every song plays every round against a song with a similar
// record. Nobody is knocked out, so one bad draw can't bury a great song.
// Stage 2, Finals: the top K (by rating) are sorted exactly by insertion, reusing
// any head-to-head you've already decided.
// Ratings come from a Bradley-Terry fit over every pick you've made.

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function suggestedRounds(n) {
  return Math.max(3, Math.ceil(Math.log2(Math.max(n, 2))));
}

export function newTournament(ids, rounds, seed = (Math.random() * 2 ** 32) >>> 0) {
  const st = {
    v: 1,
    seed,
    rngCalls: 0,
    active: [...ids],
    removed: [],
    matches: [],
    stage: 'swiss',
    swiss: { round: 0, total: rounds, pairs: [], idx: 0, byes: [] },
    finals: null,
  };
  startRound(st);
  return st;
}

function rand(st) {
  // Re-derive the generator from seed + call count so saved state stays deterministic.
  const r = rng(st.seed + st.rngCalls * 7919);
  st.rngCalls++;
  return r;
}

// ---------- ratings ----------

// Bradley-Terry via Hunter's MM algorithm. Each song also plays a virtual 1-1 against
// a fixed "average" opponent, which keeps unbeaten / winless songs finite.
export function fitRatings(st) {
  const act = new Set(st.active);
  const ids = st.active;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const wins = new Float64Array(n).fill(1);
  const games = new Map(); // "i,j" -> count, i<j
  const opp = Array.from({ length: n }, () => []);
  const played = new Float64Array(n);
  const rec = ids.map(() => ({ w: 0, l: 0, t: 0 }));
  for (const m of st.matches) {
    if (!act.has(m.a) || !act.has(m.b)) continue;
    const i = idx.get(m.a), j = idx.get(m.b);
    if (m.w === 'a') { wins[i] += 1; rec[i].w++; rec[j].l++; }
    else if (m.w === 'b') { wins[j] += 1; rec[j].w++; rec[i].l++; }
    else { wins[i] += 0.5; wins[j] += 0.5; rec[i].t++; rec[j].t++; }
    played[i]++; played[j]++;
    const k = i < j ? i + ',' + j : j + ',' + i;
    games.set(k, (games.get(k) || 0) + 1);
  }
  for (const [k, c] of games) {
    const [i, j] = k.split(',').map(Number);
    opp[i].push([j, c]);
    opp[j].push([i, c]);
  }
  let p = new Float64Array(n).fill(1);
  for (let iter = 0; iter < 300; iter++) {
    const next = new Float64Array(n);
    let delta = 0;
    for (let i = 0; i < n; i++) {
      let denom = 2 / (p[i] + 1); // virtual games vs the anchor (strength 1)
      for (const [j, c] of opp[i]) denom += c / (p[i] + p[j]);
      next[i] = wins[i] / denom;
      delta = Math.max(delta, Math.abs(Math.log(next[i] / p[i])));
    }
    p = next;
    if (delta < 1e-6) break;
  }
  const out = new Map();
  ids.forEach((id, i) => out.set(id, {
    rating: Math.round(1500 + 400 * Math.log10(p[i])),
    strength: p[i],
    games: played[i],
    ...rec[i],
  }));
  return out;
}

export function lastResult(st, x, y) {
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const m = st.matches[i];
    if (m.a === x && m.b === y) return m.w === 'a' ? x : m.w === 'b' ? y : 'tie';
    if (m.a === y && m.b === x) return m.w === 'a' ? y : m.w === 'b' ? x : 'tie';
  }
  return null;
}

// ---------- Swiss ----------

function swissScores(st) {
  const s = new Map(st.active.map(id => [id, 0]));
  for (const m of st.matches) {
    if (m.st !== 'swiss') continue;
    if (m.w === 'a' && s.has(m.a)) s.set(m.a, s.get(m.a) + 1);
    else if (m.w === 'b' && s.has(m.b)) s.set(m.b, s.get(m.b) + 1);
    else if (m.w === 't') {
      if (s.has(m.a)) s.set(m.a, s.get(m.a) + 0.5);
      if (s.has(m.b)) s.set(m.b, s.get(m.b) + 0.5);
    }
  }
  return s;
}

function startRound(st) {
  const sw = st.swiss;
  sw.round++;
  sw.idx = 0;
  const r = rand(st);
  let order = shuffle([...st.active], r);
  if (sw.round > 1) {
    const score = swissScores(st);
    const rt = fitRatings(st);
    order.sort((a, b) => score.get(b) - score.get(a) || rt.get(b).strength - rt.get(a).strength);
  }
  if (order.length % 2) {
    // Bye goes to the lowest-placed song that hasn't had one yet.
    let k = order.length - 1;
    while (k > 0 && sw.byes.includes(order[k])) k--;
    sw.byes.push(order[k]);
    order.splice(k, 1);
  }
  const met = new Set();
  for (const m of st.matches) met.add(m.a + '|' + m.b).add(m.b + '|' + m.a);
  const pairs = [];
  const left = order;
  while (left.length >= 2) {
    const a = left.shift();
    // Closest-ranked opponent it hasn't met yet; look a little further down before allowing a rematch.
    let j = left.findIndex((b, i) => i < 40 && !met.has(a + '|' + b));
    if (j < 0) j = 0;
    const [b] = left.splice(j, 1);
    pairs.push(r() < 0.5 ? [a, b] : [b, a]);
  }
  sw.pairs = shuffle(pairs, r);
}

// ---------- Finals ----------

export function startFinals(st, k) {
  const rt = fitRatings(st);
  const ranked = [...st.active].sort((a, b) => rt.get(b).strength - rt.get(a).strength);
  k = Math.min(k, ranked.length);
  st.stage = 'finals';
  st.finals = { k, sorted: [], queue: ranked.slice(0, k), x: null, lo: 0, hi: 0, mode: 'gallop', step: 1 };
  advanceFinals(st);
}

// Pull more songs into the finals (e.g. extend an exact top 50 to a top 100).
export function extendFinals(st, extra) {
  const f = st.finals;
  const inFinals = new Set([...f.sorted, ...f.queue, f.x].filter(Boolean));
  const rt = fitRatings(st);
  const rest = st.active.filter(id => !inFinals.has(id)).sort((a, b) => rt.get(b).strength - rt.get(a).strength);
  const add = rest.slice(0, extra);
  f.queue.push(...add);
  f.k += add.length;
  st.stage = 'finals';
  advanceFinals(st);
}

function nextProbe(f) {
  if (f.mode === 'gallop') return Math.max(f.lo, f.hi - f.step);
  return Math.floor((f.lo + f.hi) / 2);
}

// Applies "x beats S[p]" / "S[p] beats x" to the insertion search window.
function applyFinals(f, p, xWon) {
  if (xWon) {
    f.hi = p;
    if (f.mode === 'gallop') f.step *= 2;
  } else {
    f.lo = p + 1;
    f.mode = 'binary';
  }
}

function advanceFinals(st) {
  const f = st.finals;
  for (;;) {
    if (f.x == null) {
      if (!f.queue.length) { st.stage = 'done'; return; }
      f.x = f.queue.shift();
      f.lo = 0; f.hi = f.sorted.length; f.mode = 'gallop'; f.step = 1;
    }
    if (f.lo >= f.hi) {
      f.sorted.splice(f.lo, 0, f.x);
      f.x = null;
      continue;
    }
    const p = nextProbe(f);
    const known = lastResult(st, f.x, f.sorted[p]);
    if (known === f.x || known === f.sorted[p]) { applyFinals(f, p, known === f.x); continue; }
    return; // needs a real pick
  }
}

// ---------- shared ----------

// The matchup the user should decide now, or null if the stage is waiting / done.
export function current(st) {
  if (st.stage === 'swiss') {
    const pr = st.swiss.pairs[st.swiss.idx];
    return pr ? { a: pr[0], b: pr[1], allowTie: true } : null;
  }
  if (st.stage === 'finals') {
    const f = st.finals;
    if (f.x == null) return null;
    const p = nextProbe(f);
    // Keep left/right placement stable-but-mixed so the challenger isn't always on one side.
    const flip = (f.queue.length + p) % 2 === 1;
    return flip ? { a: f.sorted[p], b: f.x, allowTie: false } : { a: f.x, b: f.sorted[p], allowTie: false };
  }
  return null;
}

// winner: 'a' | 'b' | 't'
export function pick(st, winner) {
  const m = current(st);
  if (!m) return;
  if (winner === 't' && !m.allowTie) return;
  st.matches.push({ a: m.a, b: m.b, w: winner, st: st.stage, r: st.stage === 'swiss' ? st.swiss.round : 0 });
  if (st.stage === 'swiss') {
    st.swiss.idx++;
    if (st.swiss.idx >= st.swiss.pairs.length) {
      if (st.swiss.round < st.swiss.total) startRound(st);
      else st.stage = 'swissDone';
    }
  } else {
    const f = st.finals;
    const p = nextProbe(f);
    const winnerId = winner === 'a' ? m.a : m.b;
    applyFinals(f, p, winnerId === f.x);
    advanceFinals(st);
  }
}

// Push the current Swiss matchup to the back of this round.
export function skip(st) {
  if (st.stage !== 'swiss') return;
  const sw = st.swiss;
  if (sw.pairs.length - sw.idx < 2) return;
  const [pr] = sw.pairs.splice(sw.idx, 1);
  sw.pairs.push(pr);
}

export function addRound(st) {
  if (st.stage !== 'swissDone') return;
  st.swiss.total++;
  st.stage = 'swiss';
  startRound(st);
}

export function removeSong(st, id) {
  if (!st.active.includes(id)) return;
  st.active = st.active.filter(x => x !== id);
  st.removed.push(id);
  if (st.stage === 'swiss') {
    const sw = st.swiss;
    // Drop unplayed pairs containing it; its opponent sits this round out.
    sw.pairs = sw.pairs.filter((pr, i) => i < sw.idx || !pr.includes(id));
    if (sw.idx >= sw.pairs.length) {
      if (sw.round < sw.total) startRound(st); else st.stage = 'swissDone';
    }
  } else if (st.finals) {
    const f = st.finals;
    f.queue = f.queue.filter(x => x !== id);
    const at = f.sorted.indexOf(id);
    if (at >= 0) {
      f.sorted.splice(at, 1);
      // Restart the current insertion; cached results make this cheap.
      if (f.x != null) { f.lo = 0; f.hi = f.sorted.length; f.mode = 'gallop'; f.step = 1; }
    }
    if (f.x === id) f.x = null;
    f.k = f.sorted.length + f.queue.length + (f.x != null ? 1 : 0);
    if (st.stage !== 'swissDone') advanceFinals(st);
  }
}

// Full ranking: exact finals order on top (locked), everything else by rating.
export function ranking(st) {
  const rt = fitRatings(st);
  const locked = st.finals ? st.finals.sorted.filter(id => st.active.includes(id)) : [];
  const lockedSet = new Set(locked);
  const rest = st.active.filter(id => !lockedSet.has(id)).sort((a, b) => rt.get(b).strength - rt.get(a).strength);
  return [
    ...locked.map(id => ({ id, locked: true, ...rt.get(id) })),
    ...rest.map(id => ({ id, locked: false, ...rt.get(id) })),
  ];
}

export function progress(st) {
  const picks = st.matches.length;
  const n = st.active.length;
  const perRound = Math.floor(n / 2);
  if (st.stage === 'swiss' || st.stage === 'swissDone') {
    const sw = st.swiss;
    const doneInRound = st.stage === 'swissDone' ? sw.pairs.length : sw.idx;
    return {
      picks,
      label: `Round ${sw.round} of ${sw.total}`,
      inStage: doneInRound,
      stageSize: sw.pairs.length,
      remainingSwiss: (sw.pairs.length - doneInRound) + (sw.total - sw.round) * perRound,
    };
  }
  const f = st.finals;
  return {
    picks,
    label: st.stage === 'done' ? 'Finished' : `Finals · top ${f.k}`,
    inStage: f.sorted.length,
    stageSize: f.k,
  };
}

// Rough cost estimates for the setup screen.
export function estimatePicks(n, rounds, k) {
  const swiss = Math.floor(n / 2) * rounds;
  const finals = Math.round(Math.min(k, n) * 3);
  return { swiss, finals, total: swiss + finals };
}
