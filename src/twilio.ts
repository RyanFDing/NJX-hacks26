import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { checkWhitelist, logCall } from './db.js';
import { forwardCall, startScreening } from './twiml.js';
import crypto from 'crypto';

export function handleIncomingCall(req: Request, res: Response, db: Database.Database, config: Config): void {
  const callerNumber = req.body.From || '';
  const callSid = req.body.CallSid || crypto.randomUUID();

  const whitelisted = checkWhitelist(db, callerNumber);

  if (whitelisted) {
    logCall(db, {
      id: callSid,
      caller_number: callerNumber,
      caller_name: whitelisted.name,
      stated_relationship: whitelisted.relationship,
      stated_purpose: null,
      knew_recipient_name: null,
      confidence_score: 1.0,
      risk_reasoning: 'Whitelisted contact',
      outcome: 'whitelisted',
      transcript: null,
      created_at: new Date().toISOString(),
    });

    res.type('text/xml');
    res.send(forwardCall(config.recipientPhoneNumber));
    return;
  }

  // Unknown caller — start screening
  const host = req.headers.host || 'localhost';
  const protocol = host.includes('ngrok') || host.includes('localhost') ? 'wss' : 'wss';
  const wsUrl = `${protocol}://${host}/media-stream`;

  res.type('text/xml');
  res.send(startScreening(wsUrl, callerNumber));
}

export function handleCallStatus(req: Request, res: Response): void {
  // Status callback — log if needed in later phases
  res.status(200).end();
}
