import type { CallRecord } from './types.js';

export interface AlertConfig {
  ntfyTopic: string;
  recipientName: string;
}

export async function sendAlert(record: CallRecord, alertConfig: AlertConfig): Promise<void> {
  if (!['blocked', 'held', 'forwarded'].includes(record.outcome)) {
    return;
  }

  const confidence = record.confidence_score != null
    ? `${Math.round(record.confidence_score * 100)}%`
    : 'N/A';

  let title: string;
  let body: string;
  let priority: string;
  let tags: string;

  if (record.outcome === 'blocked') {
    title = `GuardLine: Scam BLOCKED for ${alertConfig.recipientName}`;
    body = [
      `From: ${record.caller_number}`,
      record.caller_name ? `Caller: ${record.caller_name}` : null,
      `Trust score: ${confidence}`,
      `Reason: ${record.risk_reasoning || 'No details available.'}`,
    ].filter(Boolean).join('\n');
    priority = 'urgent';
    tags = 'rotating_light';
  } else if (record.outcome === 'held') {
    title = `GuardLine: Suspicious Call Connecting to ${alertConfig.recipientName}`;
    body = [
      `From: ${record.caller_number}`,
      record.caller_name ? `Caller: ${record.caller_name}` : null,
      `Trust score: ${confidence} — flagged as uncertain, connecting anyway.`,
      `Reason: ${record.risk_reasoning || 'No details available.'}`,
    ].filter(Boolean).join('\n');
    priority = 'high';
    tags = 'warning';
  } else {
    // forwarded — low-priority heads-up that a cleared call is coming through
    title = `GuardLine: Call Cleared for ${alertConfig.recipientName}`;
    body = [
      `From: ${record.caller_number}`,
      record.caller_name ? `Caller: ${record.caller_name}` : null,
      `Trust score: ${confidence}`,
    ].filter(Boolean).join('\n');
    priority = 'default';
    tags = 'white_check_mark';
  }

  try {
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(alertConfig.ntfyTopic)}`, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        'Tags': tags,
        'Content-Type': 'text/plain',
      },
      body,
    });
    if (!response.ok) {
      console.error(`ntfy alert failed: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error('Failed to send ntfy alert:', err);
  }
}
