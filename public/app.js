const REFRESH_INTERVAL = 10000; // 10 seconds

async function fetchStats() {
  try {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error('Failed to fetch stats');
    const stats = await response.json();
    updateStats(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
  }
}

async function fetchCalls() {
  try {
    const response = await fetch('/api/calls');
    if (!response.ok) throw new Error('Failed to fetch calls');
    const calls = await response.json();
    updateCallsTable(calls);
  } catch (error) {
    console.error('Error fetching calls:', error);
  }
}

function updateStats(stats) {
  document.getElementById('stat-total').textContent = stats.total || 0;
  document.getElementById('stat-blocked').textContent = stats.blocked || 0;
  document.getElementById('stat-forwarded').textContent = stats.forwarded || 0;
  document.getElementById('stat-held').textContent = stats.held || 0;
  document.getElementById('stat-whitelisted').textContent = stats.whitelisted || 0;
}

function updateCallsTable(calls) {
  const tbody = document.getElementById('calls-tbody');

  if (!calls || calls.length === 0) {
    tbody.innerHTML = '<tr class="no-data"><td colspan="6">No calls yet</td></tr>';
    return;
  }

  tbody.innerHTML = calls.map(call => {
    const timestamp = formatTimestamp(call.created_at);
    const callerName = call.caller_name || '—';
    const outcome = formatOutcome(call.outcome);
    const confidence = formatConfidence(call.confidence_score);
    const reasoning = call.risk_reasoning || '—';

    return `
      <tr>
        <td>${timestamp}</td>
        <td>${escapeHtml(call.caller_number)}</td>
        <td>${escapeHtml(callerName)}</td>
        <td>${outcome}</td>
        <td>${confidence}</td>
        <td><span class="reasoning-text" title="${escapeHtml(reasoning)}">${escapeHtml(reasoning)}</span></td>
      </tr>
    `;
  }).join('');
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;

  const options = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  };
  return date.toLocaleString('en-US', options);
}

function formatOutcome(outcome) {
  const classMap = {
    blocked: 'outcome-blocked',
    forwarded: 'outcome-forwarded',
    held: 'outcome-held',
    whitelisted: 'outcome-whitelisted'
  };
  const className = classMap[outcome] || '';
  const label = outcome.charAt(0).toUpperCase() + outcome.slice(1);
  return `<span class="outcome-badge ${className}">${label}</span>`;
}

function formatConfidence(score) {
  if (score === null || score === undefined) return '—';

  const percentage = Math.round(score * 100);
  let className = 'confidence-low';

  if (percentage >= 70) {
    className = 'confidence-high';
  } else if (percentage >= 40) {
    className = 'confidence-medium';
  }

  return `<span class="confidence-score ${className}">${percentage}%</span>`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateRefreshStatus() {
  const status = document.getElementById('refresh-status');
  status.textContent = 'Updated just now';

  let countdown = REFRESH_INTERVAL / 1000;
  const interval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(interval);
      status.textContent = 'Refreshing...';
    } else {
      status.textContent = `Next refresh in ${countdown}s`;
    }
  }, 1000);
}

async function refreshDashboard() {
  await Promise.all([fetchStats(), fetchCalls()]);
  updateRefreshStatus();
}

// Initial load
refreshDashboard();

// Auto-refresh every 10 seconds
setInterval(refreshDashboard, REFRESH_INTERVAL);
