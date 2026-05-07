import { state, currentSide, currentBatter, currentBatterSlot, canRedraw, getActiveEventCards } from './state.js';
import { RESULT_COLOR, RESULT_LABEL, SPECIAL_META, ALL_SPECIAL_TYPES } from './cards.js';
import { hasRunner } from './sim.js';

// ── Screens ───────────────────────────────────────────────────────────────────

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

// ── Picker ────────────────────────────────────────────────────────────────────

export function renderDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  document.getElementById('date-display').textContent =
    d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  document.getElementById('btn-next-day').disabled = new Date(dateStr + 'T12:00:00') > today;
}

export function renderGameList(games) {
  const el = document.getElementById('game-list');
  if (!games.length) { el.innerHTML = '<div class="no-games">No completed games found.</div>'; return; }

  // Percentile-based difficulty — always spreads across the day's games
  const allHits = games.flatMap(g => [g.awayHits, g.homeHits]).filter(h => h > 0).sort((a, b) => a - b);
  const pct = h => {
    if (!allHits.length) return 0.5;
    const below = allHits.filter(x => x < h).length;
    return below / allHits.length;
  };
  const diffLabel = h => pct(h) >= 0.67 ? '●●●' : pct(h) >= 0.33 ? '●●' : '●';
  const diffCls   = h => pct(h) >= 0.67 ? 'diff-easy' : pct(h) >= 0.33 ? 'diff-med' : 'diff-hard';

  el.innerHTML = games.map(g => `
    <button class="game-card" data-pk="${g.gamePk}">
      <div class="game-card-row">
        <span class="team">${g.awayTeam.abbreviation}</span>
        <span class="final-score-display">${g.awayScore}</span>
        <span class="vs">—</span>
        <span class="final-score-display">${g.homeScore}</span>
        <span class="team">${g.homeTeam.abbreviation}</span>
      </div>
      <div class="game-card-sub">
        <span class="diff-badge ${diffCls(g.awayHits)}" title="${g.awayHits} hits">${diffLabel(g.awayHits)} ${g.awayTeam.abbreviation}</span>
        <span class="game-meta-small">${g.awayTeam.name} at ${g.homeTeam.name}</span>
        <span class="diff-badge ${diffCls(g.homeHits)}" title="${g.homeHits} hits">${diffLabel(g.homeHits)} ${g.homeTeam.abbreviation}</span>
      </div>
    </button>`).join('');
}

// ── Team select ───────────────────────────────────────────────────────────────

export function renderTeamSelect(game) {
  document.getElementById('team-select-title').textContent = `${game.awayTeam.name} @ ${game.homeTeam.name}`;
  document.getElementById('team-options').innerHTML = `
    <button class="team-btn" data-side="away">
      <div class="team-btn-label">AWAY</div>
      <div class="team-btn-name">${game.awayTeam.name}</div>
    </button>
    <button class="team-btn" data-side="home">
      <div class="team-btn-label">HOME</div>
      <div class="team-btn-name">${game.homeTeam.name}</div>
    </button>`;
}

// ── Config screen ─────────────────────────────────────────────────────────────

export function renderConfigScreen(game, side, seededSpecials) {
  const sideTeam = side === 'away' ? game.awayTeam.name : game.homeTeam.name;
  document.getElementById('config-matchup').textContent =
    `${game.awayTeam.abbreviation} @ ${game.homeTeam.abbreviation}  ·  Playing as ${sideTeam}`;
  renderConfigMode('game', seededSpecials, {});
}

export function renderConfigMode(mode, seededSpecials, customCounts, randomCount = 5) {
  const contentEl = document.getElementById('config-content');
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode));

  if (mode === 'game') {
    const groups = {};
    for (const c of seededSpecials) {
      groups[c.specialType] = (groups[c.specialType] || 0) + 1;
    }
    const total = seededSpecials.length;
    if (!total) {
      contentEl.innerHTML = `<div class="config-empty">No special cards were detected in this game's data.<br>Switch to Custom to add some manually.</div>`;
    } else {
      contentEl.innerHTML = `
        <div class="seeded-grid">
          ${ALL_SPECIAL_TYPES.map(type => {
            const n = groups[type] || 0;
            if (!n) return '';
            const m = SPECIAL_META[type];
            return `<div class="seeded-card" data-tip="${m.desc}">
              <span class="seeded-icon">${m.icon}</span>
              <span class="seeded-label">${m.label}</span>
              <span class="seeded-count">×${n}</span>
            </div>`;
          }).filter(Boolean).join('')}
        </div>
        <div class="config-total">${total} special card${total !== 1 ? 's' : ''} will be shuffled into your deck</div>`;
    }
  } else if (mode === 'custom') {
    const MAX_EACH = 3;
    const currentCounts = { ...customCounts };
    contentEl.innerHTML = `
      <div class="custom-sliders">
        ${ALL_SPECIAL_TYPES.map(type => {
          const m = SPECIAL_META[type];
          const val = currentCounts[type] ?? 0;
          return `<div class="slider-row">
            <span class="slider-icon">${m.icon}</span>
            <span class="slider-label">${m.label}</span>
            <span class="tip-icon" data-tip="${m.desc}">ⓘ</span>
            <input type="range" class="special-slider" data-type="${type}"
              min="0" max="${MAX_EACH}" value="${val}" step="1">
            <span class="slider-val" id="sv-${type}">${val}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="config-total" id="custom-total-display"></div>`;
    updateCustomTotal(customCounts);
  } else {
    // Random mode
    contentEl.innerHTML = `
      <div class="random-picker">
        <div class="random-row">
          <span class="random-label">How many special cards?</span>
          <input type="range" class="random-slider" id="random-count-slider"
            min="1" max="9" value="${randomCount}" step="1">
          <span class="random-val" id="rv-random">${randomCount}</span>
        </div>
        <div class="config-total" id="random-total-display">${randomCount} card${randomCount !== 1 ? 's' : ''} — types drawn randomly at game start</div>
      </div>`;
  }
}

export function updateCustomTotal(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const el = document.getElementById('custom-total-display');
  if (el) el.textContent = `${total} / 8 special cards`;
  return total;
}

// ── Scoreboard ────────────────────────────────────────────────────────────────

export function renderScoreboard() {
  const { selectedGame, score, inningScores, inning, isTop } = state;
  const away = selectedGame?.awayTeam?.abbreviation ?? 'AWY';
  const home = selectedGame?.homeTeam?.abbreviation ?? 'HME';
  const cell = (val, active) =>
    `<td class="sb-cell${active ? ' active' : ''}">${val === null ? (active ? '·' : '') : val}</td>`;
  const awayRow = Array.from({ length: 9 }, (_, i) => cell(inningScores.away[i], isTop && inning === i + 1)).join('');
  const homeRow = Array.from({ length: 9 }, (_, i) => cell(inningScores.home[i], !isTop && inning === i + 1)).join('');
  document.getElementById('scoreboard').innerHTML = `
    <table class="sb-table">
      <thead><tr>
        <th class="sb-team-col"></th>
        ${[1,2,3,4,5,6,7,8,9].map(n => `<th class="sb-cell">${n}</th>`).join('')}
        <th class="sb-r">R</th>
      </tr></thead>
      <tbody>
        <tr><td class="sb-team-col">${away}</td>${awayRow}<td class="sb-r">${score.away}</td></tr>
        <tr><td class="sb-team-col">${home}</td>${homeRow}<td class="sb-r">${score.home}</td></tr>
      </tbody>
    </table>`;
}

// ── Diamond ───────────────────────────────────────────────────────────────────

export function renderDiamond() {
  const [r1, r2, r3] = state.bases;
  [[`runner-1`,r1],[`runner-2`,r2],[`runner-3`,r3]].forEach(([id, on]) => {
    document.getElementById(id).style.opacity = on ? '1' : '0';
  });
  [[`base-1`,r1],[`base-2`,r2],[`base-3`,r3]].forEach(([id, on]) => {
    document.getElementById(id).style.fill = on ? '#f59e0b' : '#2a2d3e';
  });
}

export function renderGameStatus() {
  const ord = ['','1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
  document.getElementById('inning-display').textContent =
    `${state.isTop ? '▲' : '▼'} ${ord[state.inning] ?? state.inning}`;
  for (let i = 0; i < 3; i++)
    document.getElementById(`out-${i}`).classList.toggle('filled', i < state.outs);
}

export function renderCurrentBatter() {
  const batter = currentBatter();
  const slot = currentBatterSlot();
  const side = currentSide();
  const teamName = side === 'away' ? state.selectedGame?.awayTeam?.name : state.selectedGame?.homeTeam?.name;
  const hnr = state[side].hitAndRunActive ? '  ↗ HIT & RUN' : '';
  const el = document.getElementById('current-batter');
  el.textContent = batter ? `${batter.name}  ·  #${slot}  ·  ${teamName}${hnr}` : (teamName ?? '');
  el.classList.toggle('hnr-active', state[side].hitAndRunActive);
}

export function renderDeckInfo() {
  const s = state[currentSide()];
  document.getElementById('deck-count').textContent    = `Deck ${s.deck.length}`;
  document.getElementById('discard-count').textContent = `Discard ${s.discard.length}`;
  document.getElementById('burned-count').textContent  = `Burned ${s.burned.length}`;
  document.getElementById('cycle-count').textContent   = s.deckCycles > 0 ? `Cycle ${s.deckCycles + 1}` : '';
  const btn = document.getElementById('btn-redraw');
  const ready = canRedraw();
  const hand = state[currentSide()].hand;
  const hasOnlySpecials = ready && hand.length > 0;
  btn.disabled = !ready;
  btn.classList.toggle('ready', ready);
  btn.textContent = hasOnlySpecials ? '✕ Discard & Redraw' : (ready ? '↺ Draw New Hand' : '↺ Redraw');
}

export function renderEventPool() {
  const cards = getActiveEventCards();
  const el = document.getElementById('event-pool');
  if (!cards.length) { el.innerHTML = '<span class="no-events">—</span>'; return; }
  const hasRunners = hasRunner(state.bases);
  el.innerHTML = cards.map(c => {
    const needsRunner = c.eventType === 'SB' || c.eventType === 'CS';
    const disabled = needsRunner && !hasRunners;
    return `<button class="event-card ${c.eventType.toLowerCase()} ${disabled ? 'disabled' : ''}"
      data-id="${c.id}" ${disabled ? 'disabled' : ''} title="${c.description}">${c.eventType}</button>`;
  }).join('');
}

// ── Hand ──────────────────────────────────────────────────────────────────────

export function renderOutMeter() {
  const el = document.getElementById('out-meter');
  if (!el) return;
  const count = state[currentSide()].consecutiveOuts;
  const pips = Array.from({ length: 5 }, (_, i) =>
    `<span class="meter-pip${i < count ? ' filled' : ''}"></span>`).join('');
  el.innerHTML = `<span class="meter-label">GRIND</span>${pips}`;
}

export function renderHand() {
  const side = currentSide();
  const hand = state[side].hand;
  const discardMode = state.discardOneMode;
  const coachMode = state.battingCoachMode;
  const retainMode = state.retainMode;
  const retained = state[side].pendingRetain;
  const el = document.getElementById('hand-container');

  el.classList.toggle('discard-one-mode', discardMode);
  el.classList.toggle('batting-coach-mode', coachMode);
  el.classList.toggle('retain-mode', retainMode);

  const modeMsg = discardMode ? 'Select a card to discard'
    : coachMode ? 'Select a card to upgrade'
    : retainMode ? 'Select a card to keep after this half-inning'
    : null;

  if (modeMsg) {
    document.getElementById('hand-mode-banner').textContent = modeMsg;
    document.getElementById('hand-mode-banner').style.display = 'block';
  } else {
    document.getElementById('hand-mode-banner').style.display = 'none';
  }

  if (!hand.length) {
    el.innerHTML = canRedraw()
      ? '<div class="hand-empty-msg">Hand empty — draw a new hand</div>'
      : '<div class="no-cards">No cards</div>';
    return;
  }
  const onlySpecials = hand.every(c => c.type !== 'ab');
  const specialsNote = onlySpecials
    ? '<div class="specials-only-note">No AB cards — discard these and redraw</div>'
    : '';
  el.innerHTML = specialsNote + hand.map(card => {
    const isRetained = retained && card.id === retained.id;
    if (card.type === 'special') return specialCardHtml(card, discardMode, coachMode, isRetained);
    if (card.type === 'event')   return eventCardHtml(card, discardMode, coachMode);
    return abCardHtml(card, discardMode, coachMode, isRetained);
  }).join('');
}

function abCardHtml(card, discardMode, coachMode, isRetained = false) {
  const color     = RESULT_COLOR[card.result] ?? 'yellow';
  const label     = RESULT_LABEL[card.result] ?? card.result;
  const origLabel = (card.degraded > 0 && card.originalResult !== card.result)
    ? `<div class="card-original">${RESULT_LABEL[card.originalResult] ?? card.originalResult}</div>` : '';
  const degradeBadge = card.degraded > 0 ? `<div class="degrade-badge">↓${card.degraded}</div>` : '';
  const upgradeBadge = card.upgraded ? `<div class="upgrade-badge">⬆</div>` : '';
  const wornClass = card.degraded >= 2 ? 'worn-heavy' : card.degraded === 1 ? 'worn-light' : '';
  const actionClass = discardMode && isRetained ? 'unplayable' : (discardMode || coachMode) ? 'target-select' : 'playable';
  const retainedMark = isRetained ? '<div class="retained-pin">📌</div>' : '';

  return `<button class="ab-card color-${color} ${actionClass} ${wornClass}${isRetained ? ' is-retained' : ''}" data-id="${card.id}" data-type="ab" ${discardMode && isRetained ? 'disabled' : ''}>
    ${retainedMark}
    <div class="card-player">${card.playerName}</div>
    <div class="card-result">${label}</div>
    ${origLabel}${degradeBadge}${upgradeBadge}
    <div class="card-desc">${card.description.slice(0, 70)}${card.description.length > 70 ? '…' : ''}</div>
  </button>`;
}

function specialCardHtml(card, discardMode, coachMode, isRetained = false) {
  const meta = SPECIAL_META[card.specialType] ?? { label: card.specialType, icon: '★', category: 'SPECIAL', desc: '' };
  const actionClass = discardMode && isRetained ? 'unplayable' : (discardMode || coachMode) ? 'target-select' : 'playable';
  const retainedMark = isRetained ? '<div class="retained-pin">📌</div>' : '';
  return `<button class="special-card ${actionClass}${isRetained ? ' is-retained' : ''}" data-id="${card.id}" data-type="special" ${discardMode && isRetained ? 'disabled' : ''}>
    ${retainedMark}
    <div class="special-category">${meta.category}</div>
    <div class="special-icon">${meta.icon}</div>
    <div class="special-label">${meta.label}</div>
    <div class="special-desc">${meta.desc}</div>
  </button>`;
}

const EVENT_META = {
  SB:  { icon: '→', label: 'STOLEN BASE',  colorClass: 'ev-blue' },
  WP:  { icon: '~', label: 'WILD PITCH',   colorClass: 'ev-teal' },
  PB:  { icon: '~', label: 'PASSED BALL',  colorClass: 'ev-teal' },
};

function eventCardHtml(card, discardMode, coachMode) {
  const m = EVENT_META[card.eventType] ?? { icon: '?', label: card.eventType, colorClass: '' };
  const needsRunner = true; // SB/WP/PB all require runners
  const canPlay = !needsRunner || hasRunner(state.bases);
  const actionClass = (discardMode || coachMode) ? 'target-select' : canPlay ? 'playable' : 'unplayable';
  return `<button class="event-hand-card ${m.colorClass} ${actionClass}" data-id="${card.id}" data-type="event" ${!canPlay ? 'disabled' : ''}>
    <div class="event-hand-type">${card.eventType}</div>
    <div class="event-hand-icon">${m.icon}</div>
    <div class="event-hand-desc">${card.description.slice(0, 60)}${card.description.length > 60 ? '…' : ''}</div>
  </button>`;
}

// ── Ticker ────────────────────────────────────────────────────────────────────

export function addTickerEntry(text, type = '') {
  const log = document.getElementById('ticker-log');
  const entry = document.createElement('div');
  entry.className = `ticker-entry${type ? ' ' + type : ''}`;
  entry.textContent = text;
  log.prepend(entry);
  while (log.children.length > 30) log.lastChild.remove();
}

// ── Pick-from-cards modal (shared by mound visit, draw2, recalled) ────────────

export function showPickModal({ title, subtitle, cards, minPick = 1, maxPick = 1, confirmLabel = 'Confirm' }, onConfirm) {
  let selected = new Set();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const render = () => {
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">${title}</div>
        <div class="modal-subtitle">${subtitle}</div>
        <div class="pick-cards">
          ${cards.map(card => {
            const sel = selected.has(card.id);
            if (card.type === 'special') {
              const m = SPECIAL_META[card.specialType] ?? { icon: '★', label: card.specialType ?? '?' };
              return `<button class="pick-card special-mini ${sel ? 'selected' : ''}" data-id="${card.id}">
                <div>${m.icon} ${m.label}</div>
                ${sel ? '<div class="pick-check">✓</div>' : ''}
              </button>`;
            }
            if (card.type === 'event') {
              const m = EVENT_META[card.eventType] ?? { icon: '?', label: card.eventType ?? '?' };
              return `<button class="pick-card special-mini ${sel ? 'selected' : ''}" data-id="${card.id}">
                <div>${m.icon} ${m.label}</div>
                <div style="font-size:.6rem;color:#9ca3af;margin-top:2px">${(card.description ?? '').slice(0, 40)}</div>
                ${sel ? '<div class="pick-check">✓</div>' : ''}
              </button>`;
            }
            const color = RESULT_COLOR[card.result] ?? 'yellow';
            const label = RESULT_LABEL[card.result] ?? card.result;
            return `<button class="pick-card ab-mini color-${color} ${sel ? 'selected' : ''}" data-id="${card.id}">
              <div class="pick-player">${card.playerName ?? ''}</div>
              <div class="pick-result">${label}</div>
              ${card.degraded > 0 ? `<div class="degrade-badge">↓${card.degraded}</div>` : ''}
              ${card.upgraded ? `<div class="upgrade-badge">⬆</div>` : ''}
              ${sel ? '<div class="pick-check">✓</div>' : ''}
            </button>`;
          }).join('')}
        </div>
        <div class="modal-actions">
          <button id="pick-confirm" class="btn-primary" ${selected.size < minPick ? 'disabled' : ''}>
            ${confirmLabel} ${maxPick > 1 ? `(${selected.size}/${maxPick})` : ''}
          </button>
        </div>
      </div>`;

    modal.querySelectorAll('.pick-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (selected.has(id)) {
          selected.delete(id);
        } else if (selected.size < maxPick) {
          selected.add(id);
        }
        render();
      });
    });

    const confirmBtn = modal.querySelector('#pick-confirm');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => {
        if (selected.size < minPick) return;
        modal.remove();
        onConfirm(cards.filter(c => selected.has(c.id)));
      });
    }
  };

  render();
  document.getElementById('app').appendChild(modal);
}

// ── Choice modal (groundout send / flyout tag-up / momentum) ─────────────────

export function showChoiceModal({ title, subtitle, options }, onChoose) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box modal-choice">
      <div class="modal-title">${title}</div>
      ${subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : ''}
      <div class="choice-options">
        ${options.map((o, i) => `
          <button class="choice-btn" data-idx="${i}">
            <div class="choice-label">${o.label}</div>
            <div class="choice-desc">${o.desc}</div>
          </button>`).join('')}
      </div>
    </div>`;
  modal.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.remove();
      onChoose(options[parseInt(btn.dataset.idx)].value);
    });
  });
  document.getElementById('app').appendChild(modal);
}

// ── Tag-up modal (flyout / lineout with runners) ──────────────────────────────

const TAG_PROB_PCT = [50, 65, 80]; // 1st→2nd, 2nd→3rd, 3rd→home
const TAG_BASE_LABELS = ['1st → 2nd', '2nd → 3rd', '3rd → Home'];

export function showTagUpModal(bases, outs, cardLabel, onConfirm) {
  const occupiedBases = [2, 1, 0].filter(i => bases[i] && outs < 2); // 3rd first
  if (!occupiedBases.length) { onConfirm([]); return; }

  const decisions = { 0: false, 1: false, 2: false };
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const render = () => {
    modal.innerHTML = `
      <div class="modal-box modal-choice">
        <div class="modal-title">TAG UP?</div>
        <div class="modal-subtitle">${cardLabel}</div>
        <div class="tagup-rows">
          ${occupiedBases.map(bi => `
            <div class="tagup-row">
              <div class="tagup-base">${TAG_BASE_LABELS[bi]}</div>
              <div class="tagup-prob">${TAG_PROB_PCT[bi]}% safe</div>
              <div class="tagup-btns">
                <button class="tagup-btn${decisions[bi] ? ' active' : ''}" data-base="${bi}" data-val="1">Tag</button>
                <button class="tagup-btn${!decisions[bi] ? ' active hold' : ''}" data-base="${bi}" data-val="0">Hold</button>
              </div>
            </div>`).join('')}
        </div>
        <div class="modal-actions">
          <button id="tagup-confirm" class="btn-primary">Play Ball</button>
        </div>
      </div>`;

    modal.querySelectorAll('.tagup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        decisions[parseInt(btn.dataset.base)] = btn.dataset.val === '1';
        render();
      });
    });
    modal.querySelector('#tagup-confirm').addEventListener('click', () => {
      modal.remove();
      onConfirm(decisions);
    });
  };

  render();
  document.getElementById('app').appendChild(modal);
}

// ── End screen ────────────────────────────────────────────────────────────────

export function renderEndScreen(yourScore, realScore) {
  const { selectedGame, playerSide } = state;
  const yours = yourScore[playerSide], real = realScore[playerSide];
  const [verdict, cls] = yours > real
    ? [`You outperformed history — ${yours} runs vs. real ${real}`, 'verdict-win']
    : yours === real
    ? [`You matched history exactly — ${yours} runs`, 'verdict-tie']
    : [`History wins — you scored ${yours}, real game had ${real}`, 'verdict-loss'];
  const away = selectedGame?.awayTeam?.abbreviation ?? 'AWY';
  const home = selectedGame?.homeTeam?.abbreviation ?? 'HME';
  document.getElementById('end-verdict').innerHTML = `<div class="${cls}">${verdict}</div>`;
  document.getElementById('end-boxscore').innerHTML = `
    <div class="boxscore">
      <h3>YOUR GAME</h3><div class="final-score">${away} ${yourScore.away} — ${yourScore.home} ${home}</div>
      <h3>REAL RESULT</h3><div class="final-score">${away} ${realScore.away} — ${realScore.home} ${home}</div>
    </div>`;
}

export function renderAll() {
  renderScoreboard(); renderDiamond(); renderGameStatus();
  renderDeckInfo(); renderEventPool(); renderHand(); renderOutMeter();
}
