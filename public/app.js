/* ═══════════════════════════════════════════════════════
   GuardLine — Frontend Application
   Routing · Data · Rendering · Interactions
═══════════════════════════════════════════════════════ */

const REFRESH_INTERVAL = 10_000;
const APPROVE_MIN_CONFIDENCE = 0.65;
const REJECT_MAX_CONFIDENCE  = 0.15;

let cachedCalls = [];
let refreshTimer = null;
let countdownTimer = null;

/* ══════════════════════════════════════════════════════
   ROUTING — hash-based SPA navigation
══════════════════════════════════════════════════════ */

const TABS = ['dashboard', 'whitelist', 'preferences', 'alerts'];

function route() {
  const hash = location.hash.replace(/^#\/?/, '').toLowerCase();
  if (TABS.includes(hash)) {
    showApp(hash);
  } else {
    showLanding();
  }
}

function showLanding() {
  document.getElementById('landing').hidden = false;
  document.getElementById('app').hidden = true;
  stopRefreshLoop();
}

function showApp(tab = 'dashboard') {
  document.getElementById('landing').hidden = true;
  document.getElementById('app').hidden = false;
  activateTab(tab);
  startRefreshLoop();
}

function enterApp(tab = 'dashboard') {
  location.hash = tab;
}

/* ══════════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════════ */

function activateTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.app-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Show correct panel
  TABS.forEach(id => {
    const panel = document.getElementById(`tab-${id}`);
    if (panel) panel.hidden = id !== tabId;
  });

  // Lazy-load tab-specific data
  if (tabId === 'whitelist') refreshWhitelist();
  if (tabId === 'preferences') refreshSecurityContext();
  if (tabId === 'alerts') loadAlertsConfig();
}

/* ══════════════════════════════════════════════════════
   API HELPERS
══════════════════════════════════════════════════════ */

async function apiFetch(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

const fetchStats          = () => apiFetch('/api/stats');
const fetchCalls          = () => apiFetch('/api/calls');
const fetchSecurityContext = () => apiFetch('/api/security-context');
const fetchWhitelist      = () => apiFetch('/api/whitelist');
const fetchAlertsConfig   = () => apiFetch('/api/alerts/config');

async function apiAddSecurityFact(fact) {
  return apiFetch('/api/security-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fact }),
  });
}

async function apiRemoveSecurityFact(id) {
  return apiFetch(`/api/security-context/${id}`, { method: 'DELETE' });
}

async function apiAddWhitelist(data) {
  return apiFetch('/api/whitelist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function apiRemoveWhitelist(id) {
  return apiFetch(`/api/whitelist/${id}`, { method: 'DELETE' });
}

async function apiTestAlert() {
  return apiFetch('/api/alerts/test', { method: 'POST' });
}

/* ══════════════════════════════════════════════════════
   DASHBOARD REFRESH LOOP
══════════════════════════════════════════════════════ */

function startRefreshLoop() {
  stopRefreshLoop();
  refreshDashboard();
  refreshTimer = setInterval(refreshDashboard, REFRESH_INTERVAL);
}

function stopRefreshLoop() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

async function refreshDashboard() {
  // Only fetch data for the dashboard tab; other tabs fetch on demand
  const dot = document.getElementById('refresh-status');
  try {
    const [stats, calls] = await Promise.all([fetchStats(), fetchCalls()]);
    document.getElementById('fetch-error').hidden = true;
    updateStats(stats);
    updateCallsTable(calls);
    if (dot) { dot.classList.add('live'); dot.classList.remove('error'); }
    startCountdown();
  } catch (err) {
    console.error('Dashboard refresh failed:', err);
    document.getElementById('fetch-error').hidden = false;
    if (dot) { dot.classList.add('error'); dot.classList.remove('live'); }
  }
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  let secs = REFRESH_INTERVAL / 1000;
  countdownTimer = setInterval(() => {
    secs--;
    if (secs <= 0) clearInterval(countdownTimer);
  }, 1000);
}

/* ══════════════════════════════════════════════════════
   RENDERING — Dashboard
══════════════════════════════════════════════════════ */

function updateStats(stats) {
  document.getElementById('stat-total').textContent      = stats.total      ?? 0;
  document.getElementById('stat-blocked').textContent    = stats.blocked    ?? 0;
  document.getElementById('stat-forwarded').textContent  = stats.forwarded  ?? 0;
  document.getElementById('stat-held').textContent       = stats.held       ?? 0;
  document.getElementById('stat-whitelisted').textContent= stats.whitelisted ?? 0;
}

function updateCallsTable(calls) {
  cachedCalls = calls || [];
  const tbody = document.getElementById('calls-tbody');

  if (!cachedCalls.length) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">
          <div class="empty-state">
            <span class="empty-icon">📞</span>
            <span>No calls yet — waiting for the first one.</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = cachedCalls.map(call => {
    const t    = formatTimestamp(call.created_at);
    const name = escapeHtml(call.caller_name || '—');
    const num  = `<span class="mono">${escapeHtml(call.caller_number)}</span>`;
    const out  = renderOutcomeBadge(call.outcome);
    const trust = renderTrustScore(call.confidence_score);
    const reason = call.risk_reasoning || '—';
    return `
      <tr class="clickable" data-id="${escapeHtml(call.id)}">
        <td>${t}</td>
        <td>${num}</td>
        <td>${name}</td>
        <td>${out}</td>
        <td>${trust}</td>
        <td><span class="reasoning-cell" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const call = cachedCalls.find(c => c.id === row.dataset.id);
      if (call) openModal(call);
    });
  });
}

/* ══════════════════════════════════════════════════════
   RENDERING — Whitelist
══════════════════════════════════════════════════════ */

function updateWhitelistTable(entries) {
  const tbody = document.getElementById('whitelist-tbody');

  if (!entries?.length) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">
          <div class="empty-state">
            <span class="empty-icon">✓</span>
            <span>No trusted contacts yet</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = entries.map(e => `
    <tr>
      <td>${escapeHtml(e.name)}</td>
      <td><span class="mono">${escapeHtml(e.phone_number)}</span></td>
      <td>${escapeHtml(e.relationship || '—')}</td>
      <td><button class="btn-delete" data-id="${escapeHtml(e.id)}">Remove</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiRemoveWhitelist(btn.dataset.id);
        showWhitelistSuccess('Contact removed.');
        await refreshWhitelist();
      } catch (err) {
        showWhitelistError(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function refreshWhitelist() {
  try {
    const entries = await fetchWhitelist();
    updateWhitelistTable(entries);
  } catch (err) {
    showWhitelistError(`Failed to load: ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════
   RENDERING — Security Context (Preferences)
══════════════════════════════════════════════════════ */

function updateSecurityTable(facts) {
  const tbody = document.getElementById('security-tbody');

  if (!facts?.length) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="3">
          <div class="empty-state">
            <span class="empty-icon">🧠</span>
            <span>No personal context yet</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = facts.map(f => `
    <tr>
      <td>${escapeHtml(f.fact)}</td>
      <td>${formatTimestamp(f.created_at)}</td>
      <td><button class="btn-delete" data-id="${escapeHtml(f.id)}">Remove</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await apiRemoveSecurityFact(btn.dataset.id);
        showSecuritySuccess('Fact removed.');
        await refreshSecurityContext();
      } catch (err) {
        showSecurityError(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function refreshSecurityContext() {
  try {
    const facts = await fetchSecurityContext();
    updateSecurityTable(facts);
  } catch (err) {
    showSecurityError(`Failed to load: ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════
   ALERTS TAB
══════════════════════════════════════════════════════ */

async function loadAlertsConfig() {
  try {
    const cfg = await fetchAlertsConfig();
    document.getElementById('ntfy-topic-display').textContent = cfg.topic || '—';
  } catch {
    document.getElementById('ntfy-topic-display').textContent = 'unavailable';
  }
}

function copyTopic() {
  const topic = document.getElementById('ntfy-topic-display').textContent;
  if (!topic || topic === '—' || topic === 'unavailable') return;
  navigator.clipboard.writeText(topic).then(() => {
    const btn = document.getElementById('btn-copy-topic');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {});
}

async function sendTestAlert() {
  const btn = document.getElementById('btn-test-alert');
  const status = document.getElementById('test-alert-status');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.hidden = true;
  status.className = 'test-status';
  try {
    await apiTestAlert();
    status.textContent = 'Test alert sent! Check your ntfy app.';
    status.classList.add('success');
    status.hidden = false;
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    status.classList.add('error');
    status.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Test Alert';
  }
}

/* ══════════════════════════════════════════════════════
   TRANSCRIPT MODAL
══════════════════════════════════════════════════════ */

function openModal(call) {
  document.getElementById('modal-title').textContent = `Call from ${call.caller_number}`;

  // Meta section
  const meta = document.getElementById('modal-meta');
  const items = [
    ['Time',        formatTimestamp(call.created_at)],
    ['Outcome',     renderOutcomeBadge(call.outcome)],
    ['Trust Score', renderTrustScore(call.confidence_score)],
    call.caller_name       ? ['Caller',       escapeHtml(call.caller_name)]       : null,
    call.stated_relationship ? ['Relationship', escapeHtml(call.stated_relationship)] : null,
    call.stated_purpose    ? ['Purpose',      escapeHtml(call.stated_purpose)]    : null,
    call.risk_reasoning    ? ['Reasoning',    escapeHtml(call.risk_reasoning)]    : null,
  ].filter(Boolean);

  meta.innerHTML = items.map(([label, value]) => `
    <div class="meta-item">
      <span class="meta-label">${label}</span>
      <span class="meta-value">${value}</span>
    </div>`).join('');

  // Red flags (remove any previous)
  document.querySelector('.modal-red-flags')?.remove();

  const redFlags = Array.isArray(call.red_flags) ? call.red_flags : [];
  if (redFlags.length) {
    const flagsEl = document.createElement('div');
    flagsEl.className = 'modal-red-flags';
    flagsEl.innerHTML = `
      <div class="red-flags-label">Red Flags</div>
      <ul class="red-flags-list">
        ${redFlags.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
      </ul>`;
    meta.after(flagsEl);
  }

  // Transcript
  const transcriptEl = document.getElementById('modal-transcript');
  let entries = [];
  if (call.transcript) {
    try {
      entries = typeof call.transcript === 'string'
        ? JSON.parse(call.transcript)
        : call.transcript;
    } catch { entries = []; }
  }

  if (!entries.length) {
    transcriptEl.innerHTML = '<div class="transcript-empty">No transcript available.</div>';
  } else {
    transcriptEl.innerHTML = entries.map(entry => `
      <div class="transcript-entry ${escapeHtml(entry.role)}">
        <span class="transcript-role">${entry.role === 'caller' ? 'Caller' : 'Receptionist'}</span>
        <div class="transcript-bubble">${escapeHtml(entry.text)}</div>
      </div>`).join('');
  }

  const modal = document.getElementById('transcript-modal');
  modal.hidden = false;
  document.getElementById('modal-close').focus();
}

function closeModal() {
  document.getElementById('transcript-modal').hidden = true;
  document.querySelector('.modal-red-flags')?.remove();
}

/* ══════════════════════════════════════════════════════
   FORMATTERS
══════════════════════════════════════════════════════ */

function renderOutcomeBadge(outcome) {
  const map = {
    blocked:    ['badge-blocked',    'Blocked'],
    forwarded:  ['badge-forwarded',  'Forwarded'],
    held:       ['badge-held',       'Held'],
    whitelisted:['badge-whitelisted','Whitelisted'],
  };
  const safe = String(outcome || '');
  const [cls, label] = map[safe] || ['', safe];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderTrustScore(score) {
  if (score == null) return '<span class="trust-score" style="color:var(--text-muted)">—</span>';
  const pct = Math.round(score * 100);
  const cls = score > APPROVE_MIN_CONFIDENCE ? 'trust-high'
            : score > REJECT_MAX_CONFIDENCE  ? 'trust-medium'
            : 'trust-low';
  return `<span class="trust-score ${cls}">${pct}%</span>`;
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  const now  = new Date();
  const diffMins = Math.floor((now - date) / 60_000);

  if (diffMins < 1)    return 'Just now';
  if (diffMins < 60)   return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;

  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/* ══════════════════════════════════════════════════════
   FEEDBACK (inline alerts)
══════════════════════════════════════════════════════ */

function showInlineAlert(elId, msg, type = 'error') {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function hideInlineAlert(elId) {
  const el = document.getElementById(elId);
  if (el) el.hidden = true;
}

function showSecurityError(msg)   { showInlineAlert('security-error', msg); }
function hideSecurityError()      { hideInlineAlert('security-error'); }
function showSecuritySuccess(msg) { showInlineAlert('security-success', msg); hideInlineAlert('security-error'); }

function showWhitelistError(msg)   { showInlineAlert('whitelist-error', msg); }
function hideWhitelistError()      { hideInlineAlert('whitelist-error'); }
function showWhitelistSuccess(msg) { showInlineAlert('whitelist-success', msg); hideInlineAlert('whitelist-error'); }

/* ══════════════════════════════════════════════════════
   FORM HANDLERS
══════════════════════════════════════════════════════ */

document.getElementById('whitelist-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  hideWhitelistError();
  hideInlineAlert('whitelist-success');

  const data = {
    phone_number: document.getElementById('wl-number').value.trim(),
    name:         document.getElementById('wl-name').value.trim(),
    relationship: document.getElementById('wl-relationship').value.trim() || undefined,
  };

  try {
    await apiAddWhitelist(data);
    e.target.reset();
    showWhitelistSuccess(`${data.name} added to trusted contacts.`);
    await refreshWhitelist();
  } catch (err) {
    showWhitelistError(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('security-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  hideSecurityError();
  hideInlineAlert('security-success');

  const fact = document.getElementById('sc-fact').value.trim();

  try {
    await apiAddSecurityFact(fact);
    e.target.reset();
    showSecuritySuccess('Fact added to personal context.');
    await refreshSecurityContext();
  } catch (err) {
    showSecurityError(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════
   EVENT WIRING
══════════════════════════════════════════════════════ */

// Landing → App CTAs
['landing-enter-btn', 'hero-enter-btn', 'footer-enter-btn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => enterApp('dashboard'));
});

// App logo → landing
document.getElementById('app-logo-btn').addEventListener('click', () => {
  location.hash = '';
});

// Tab buttons
document.querySelectorAll('.app-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    location.hash = btn.dataset.tab;
  });
});

// Modal close
document.getElementById('modal-close').addEventListener('click', closeModal);

document.getElementById('transcript-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('transcript-modal').hidden) {
    closeModal();
  }
});

// Alerts tab buttons
document.getElementById('btn-copy-topic').addEventListener('click', copyTopic);
document.getElementById('btn-test-alert').addEventListener('click', sendTestAlert);

// Hash routing
window.addEventListener('hashchange', route);

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */

route();
