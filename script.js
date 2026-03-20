/**
 * NCAA Basketball 2026 — Solari Board
 *
 * Fetches live scores from ESPN's public scoreboard API and renders them
 * as an animated split-flap / Solari electromechanical display.
 *
 * No API key required. ESPN's undocumented public endpoint is freely
 * accessible from browsers. Data refreshes every 30 seconds.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const ESPN_API =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';

const REFRESH_MS   = 30_000;   // 30 seconds
const FLIP_DURATION = 180;     // ms — must match CSS animation

// Characters the flap display can show (Solari boards had fixed char sets)
const FLAP_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-/@#&';

// ─── State ────────────────────────────────────────────────────────────────────

/** Map of gameId → { awayScore, homeScore, status, period, clock } */
const prevState = new Map();

/** Persistent cache of final games — only grows, never cleared across refreshes */
const finalGamesCache = new Map();

let latestGames    = [];
let refreshTimer   = null;
let countdownTimer = null;
let countdownSecs  = REFRESH_MS / 1000;

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Pad or truncate a string to exactly `len` chars, uppercase, Solari-safe.
 */
function toFlap(str, len) {
  const s = String(str ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .:\-\/@#&]/g, ' ')
    .padEnd(len, ' ')
    .slice(0, len);
  return s;
}

/**
 * Render a string as an array of `.flap-char` <span> elements.
 * @param {string}  text
 * @param {string}  [extraClass]
 * @param {string}  [prevText]   - previous value; changed chars get flip animation
 * @returns {DocumentFragment}
 */
function renderFlaps(text, extraClass = '', prevText = '') {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i++) {
    const ch  = text[i];
    const pch = prevText[i] ?? '';
    const span = document.createElement('span');
    span.className = 'flap-char' + (extraClass ? ` ${extraClass}` : '');
    span.textContent = ch;

    if (ch !== pch && pch !== '') {
      // stagger flips by position, capped at 4 steps
      const step = Math.min((i % 4) + 1, 4);
      span.classList.add('flipping', `flip-${step}`);
      // Remove animation class after it completes so it can replay
      span.addEventListener('animationend', () => {
        span.classList.remove('flipping', `flip-${step}`);
      }, { once: true });
    }
    frag.appendChild(span);
  }
  return frag;
}

/**
 * Create a single `.flap-char` element.
 */
function flapChar(ch, extraClass = '') {
  const span = document.createElement('span');
  span.className = 'flap-char' + (extraClass ? ` ${extraClass}` : '');
  span.textContent = ch;
  return span;
}

/**
 * Create a status badge element.
 */
function statusBadge(text, badgeClass) {
  const span = document.createElement('span');
  span.className = `status-flap ${badgeClass}`;
  span.textContent = text;
  return span;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchScores() {
  const url = new URL(ESPN_API);
  // Force today's date in ESPN format
  const today = new Date();
  // Use local date — toISOString() returns UTC which is wrong for US timezones in the evening
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  url.searchParams.set('dates', ymd);
  url.searchParams.set('limit', '200');

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Parse ESPN event JSON into a normalised game object.
 */
function parseGame(event) {
  const comp       = event.competitions?.[0];
  const away       = comp?.competitors?.find(c => c.homeAway === 'away');
  const home       = comp?.competitors?.find(c => c.homeAway === 'home');
  const status     = comp?.status;
  const statusType = status?.type;

  // Scores
  const awayScore = away?.score ?? '-';
  const homeScore = home?.score ?? '-';

  // Rankings
  const awayRank = away?.curatedRank?.current;
  const homeRank = home?.curatedRank?.current;

  // Team abbreviations — up to 4 chars, pad to 4
  const awayAbbr = toFlap(away?.team?.abbreviation ?? '???', 4);
  const homeAbbr = toFlap(home?.team?.abbreviation ?? '???', 4);

  // Game state
  const isLive     = statusType?.state === 'in';
  const isFinal    = statusType?.state === 'post';
  const isScheduled = statusType?.state === 'pre';

  // Period / clock
  const period = status?.period ?? 0;
  const clock  = status?.displayClock ?? '';

  // Period label (college basketball: 1st Half, 2nd Half, OT…)
  let periodLabel = '';
  if (isLive) {
    if      (period === 1)  periodLabel = '1H';
    else if (period === 2)  periodLabel = '2H';
    else if (period >= 3)   periodLabel = `OT${period > 3 ? period - 2 : ''}`;
  }

  // Start time (for scheduled games)
  const startTime = event.date ? formatTime(new Date(event.date)) : '';

  return {
    id: event.id,
    awayAbbr,
    homeAbbr,
    awayScore,
    homeScore,
    awayRank: awayRank && awayRank <= 25 ? awayRank : null,
    homeRank: homeRank && homeRank <= 25 ? homeRank : null,
    isLive,
    isFinal,
    isScheduled,
    period,
    periodLabel,
    clock,
    startTime,
    statusDesc: statusType?.shortDetail ?? statusType?.description ?? '',
  };
}

/**
 * Format a Date to local HH:MM AM/PM.
 */
function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ─── DOM builders ─────────────────────────────────────────────────────────────

/**
 * Build the score cell <div> for one team.
 * Scores are 1–3 digits; pad left to 3.
 */
function buildScoreCell(score, isLeading, prevScore) {
  const cell = document.createElement('div');
  cell.className = 'score-cell' + (isLeading ? ' leading' : '');

  const raw = score === '-' ? '  -' : String(score).padStart(3, ' ');
  const prv = prevScore === undefined
    ? ''
    : (prevScore === '-' ? '  -' : String(prevScore).padStart(3, ' '));

  cell.appendChild(renderFlaps(raw, '', prv));
  return cell;
}

/**
 * Build the team abbreviation cell.
 */
function buildTeamCell(abbr, isHome, prevAbbr) {
  const cell = document.createElement('div');
  cell.className = 'team-cell' + (isHome ? ' home' : '');

  const inner = document.createElement('span');
  inner.className = 'team-abbr';
  inner.appendChild(renderFlaps(abbr, '', prevAbbr ?? ''));
  cell.appendChild(inner);
  return cell;
}

/**
 * Build the rank cell (blank if unranked).
 */
function buildRankCell(rank) {
  const cell = document.createElement('div');
  cell.className = 'rank-cell';

  const flap = document.createElement('span');
  flap.className = rank ? 'rank-flap' : 'rank-flap empty';
  flap.textContent = rank ? String(rank) : '';
  cell.appendChild(flap);
  return cell;
}

/**
 * Build the status cell (LIVE + period, FINAL, or start time).
 */
function buildStatusCell(game) {
  const cell = document.createElement('div');
  cell.className = 'status-cell';

  if (game.isLive) {
    cell.appendChild(statusBadge('LIVE', 'live-badge'));
    if (game.periodLabel) {
      cell.appendChild(statusBadge(game.periodLabel, 'period-badge'));
    }
    if (game.clock) {
      const clockStr = game.clock.length > 5 ? game.clock.slice(0, 5) : game.clock;
      cell.appendChild(statusBadge(clockStr, 'period-badge'));
    }
  } else if (game.isFinal) {
    cell.appendChild(statusBadge('FINAL', 'final-badge'));
    if (game.statusDesc && game.statusDesc !== 'Final') {
      // e.g. "Final/OT"
      const extra = game.statusDesc.replace('Final', '').replace('/', '').trim();
      if (extra) cell.appendChild(statusBadge(extra, 'final-badge'));
    }
  } else {
    // Scheduled
    cell.appendChild(statusBadge(game.startTime || 'TBD', 'scheduled-badge'));
  }

  return cell;
}

/**
 * Build the divider (@) cell.
 */
function buildDividerCell() {
  const cell = document.createElement('div');
  cell.className = 'divider-cell';
  const d = document.createElement('span');
  d.className = 'divider-flap';
  d.textContent = '@';
  cell.appendChild(d);
  return cell;
}

/**
 * Build or update a single game row.
 */
function buildGameRow(game) {
  const prev = prevState.get(game.id) ?? {};

  const row = document.createElement('div');
  row.className = 'game-row' +
    (game.isLive ? ' live' : game.isFinal ? ' final' : '');
  row.dataset.gameId = game.id;

  const awayScore = Number(game.awayScore);
  const homeScore = Number(game.homeScore);
  const awayLeads = !isNaN(awayScore) && !isNaN(homeScore) && awayScore > homeScore;
  const homeLeads = !isNaN(awayScore) && !isNaN(homeScore) && homeScore > awayScore;

  row.appendChild(buildRankCell(game.awayRank));
  row.appendChild(buildTeamCell(game.awayAbbr, false, prev.awayAbbr));
  row.appendChild(buildScoreCell(game.awayScore, awayLeads, prev.awayScore));
  row.appendChild(buildDividerCell());
  row.appendChild(buildScoreCell(game.homeScore, homeLeads, prev.homeScore));
  row.appendChild(buildTeamCell(game.homeAbbr, true, prev.homeAbbr));
  row.appendChild(buildRankCell(game.homeRank));
  row.appendChild(buildStatusCell(game));

  return row;
}

/**
 * Insert a section header (e.g., "IN PROGRESS", "FINAL", "UPCOMING").
 */
function buildSectionDivider(label) {
  const div = document.createElement('div');
  div.className = 'section-divider';

  const line1 = document.createElement('span');
  line1.className = 'section-line';

  const lbl = document.createElement('span');
  lbl.className = 'section-label';
  lbl.textContent = label;

  const line2 = document.createElement('span');
  line2.className = 'section-line';

  div.appendChild(line1);
  div.appendChild(lbl);
  div.appendChild(line2);
  return div;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderBoard(games) {
  const board = document.getElementById('board');
  board.innerHTML = '';

  if (!games.length) {
    const row = document.createElement('div');
    row.className = 'no-games-row';
    row.appendChild(renderFlaps('NO GAMES TODAY'));
    board.appendChild(row);
    return;
  }

  // Sort: live first, then scheduled (by start time order), then final
  const live      = games.filter(g => g.isLive);
  const scheduled = games.filter(g => g.isScheduled);
  const final_    = games.filter(g => g.isFinal);

  const sections = [
    { label: 'IN PROGRESS',   games: live },
    { label: 'UPCOMING',      games: scheduled },
    { label: 'FINAL',         games: final_ },
  ];

  for (const section of sections) {
    if (!section.games.length) continue;
    board.appendChild(buildSectionDivider(section.label));
    for (const game of section.games) {
      board.appendChild(buildGameRow(game));
    }
  }
}

// ─── Summary modal ────────────────────────────────────────────────────────────

function buildSummaryRow(game) {
  const awayScore = Number(game.awayScore);
  const homeScore = Number(game.homeScore);
  const awayWins  = !isNaN(awayScore) && !isNaN(homeScore) && awayScore > homeScore;
  const homeWins  = !isNaN(awayScore) && !isNaN(homeScore) && homeScore > awayScore;

  const row = document.createElement('div');
  row.className = 'summary-row';

  const awayEl = document.createElement('span');
  awayEl.className = 'summary-team' + (awayWins ? ' winner' : '');
  awayEl.textContent = (game.awayRank ? `(${game.awayRank}) ` : '') + game.awayAbbr.trim();

  const scoreEl = document.createElement('span');
  scoreEl.className = 'summary-score';
  scoreEl.textContent = `${game.awayScore} – ${game.homeScore}`;

  const homeEl = document.createElement('span');
  homeEl.className = 'summary-team home' + (homeWins ? ' winner' : '');
  homeEl.textContent = game.homeAbbr.trim() + (game.homeRank ? ` (${game.homeRank})` : '');

  const statusEl = document.createElement('span');
  statusEl.className = 'summary-status';
  const extra = game.statusDesc?.replace('Final', '').replace('/', '').trim();
  statusEl.textContent = extra || 'F';

  row.appendChild(awayEl);
  row.appendChild(scoreEl);
  row.appendChild(homeEl);
  row.appendChild(statusEl);
  return row;
}

function openSummaryModal() {
  // Merge current response's finals into cache so today's games are always present
  for (const g of latestGames) {
    if (g.isFinal) finalGamesCache.set(g.id, g);
  }
  const finals = [...finalGamesCache.values()];
  const body   = document.getElementById('modal-body');
  body.innerHTML = '';

  if (!finals.length) {
    const empty = document.createElement('div');
    empty.className = 'modal-empty';
    empty.textContent = 'NO FINAL GAMES YET';
    body.appendChild(empty);
  } else {
    for (const game of finals) body.appendChild(buildSummaryRow(game));
  }

  document.getElementById('summary-modal').hidden = false;
}

function renderError(message) {
  const board = document.getElementById('board');
  board.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'error-row';
  row.innerHTML = `
    <span>⚠ FEED ERROR</span>
    <span style="font-size:10px;color:#555">${message}</span>
  `;
  board.appendChild(row);
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function updateClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true,
  });
}

// ─── Refresh countdown ────────────────────────────────────────────────────────

function startCountdown() {
  countdownSecs = REFRESH_MS / 1000;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdownSecs = Math.max(0, countdownSecs - 1);
    const el = document.getElementById('refresh-countdown');
    if (el) el.textContent = countdownSecs;
  }, 1000);
}

// ─── Main refresh loop ────────────────────────────────────────────────────────

async function refresh() {
  try {
    const data  = await fetchScores();
    const events = data.events ?? [];
    const games  = events.map(parseGame);

    latestGames = games;
    renderBoard(games);

    // Accumulate final games — never evict so results persist across refreshes
    for (const g of games) {
      if (g.isFinal) finalGamesCache.set(g.id, g);
    }

    // Update results button
    const finalCount = finalGamesCache.size;
    const btn = document.getElementById('results-btn');
    if (btn) {
      btn.disabled = finalCount === 0;
      btn.textContent = finalCount > 0 ? `RESULTS (${finalCount})` : 'RESULTS';
    }

    // Persist state for next diff
    for (const g of games) {
      prevState.set(g.id, {
        awayScore: g.awayScore,
        homeScore: g.homeScore,
        awayAbbr:  g.awayAbbr,
        homeAbbr:  g.homeAbbr,
        periodLabel: g.periodLabel,
        clock:     g.clock,
      });
    }

    startCountdown();
  } catch (err) {
    console.error('[SolariBoard]', err);
    renderError(err.message);
    startCountdown();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(function init() {
  // Clock ticks every second
  updateClock();
  setInterval(updateClock, 1000);

  // Modal controls
  document.getElementById('results-btn').addEventListener('click', openSummaryModal);
  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('summary-modal').hidden = true;
  });
  document.getElementById('summary-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  // Initial fetch
  refresh();

  // Periodic refresh
  refreshTimer = setInterval(refresh, REFRESH_MS);
})();
