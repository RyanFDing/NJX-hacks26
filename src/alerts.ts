import Twilio from 'twilio';
import type { CallRecord } from './types.js';

export interface AlertConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  emergencyContactPhone: string;
  recipientName: string;
}

export function formatAlertMessage(record: CallRecord, recipientName: string): string {
  const outcomeLabel = record.outcome === 'blocked' ? 'BLOCKED' : 'HELD FOR REVIEW';
  const confidence = record.confidence_score != null
    ? `${Math.round(record.confidence_score * 100)}%`
    : 'N/A';

  return [
    `GuardLine Alert for ${recipientName}`,
    `Call ${outcomeLabel}`,
    `From: ${record.caller_number}`,
    `Trust score: ${confidence}`,
    `Reason: ${record.risk_reasoning || 'No details available.'}`,
  ].join('\n');
}

export async function sendAlert(record: CallRecord, alertConfig: AlertConfig): Promise<void> {
  // Only alert on blocked or held calls
  if (record.outcome !== 'blocked' && record.outcome !== 'held') {
    return;
  }

  const body = formatAlertMessage(record, alertConfig.recipientName);

  try {
    const client = Twilio(alertConfig.twilioAccountSid, alertConfig.twilioAuthToken);
    await client.messages.create({
      to: alertConfig.emergencyContactPhone,
      from: alertConfig.twilioPhoneNumber,
      body,
    });
  } catch (err) {
    console.error('Failed to send SMS alert:', err);
  }
}
