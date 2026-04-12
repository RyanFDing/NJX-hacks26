import { Router } from 'express';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { getCallHistory, getCallById, getCallStats, getWhitelist, addToWhitelist, removeFromWhitelist, getSecurityContext, addSecurityFact, removeSecurityFact } from './db.js';
import { sendAlert } from './alerts.js';

export function createApiRouter(db: Database.Database, config?: Config): Router {
  const router = Router();

  router.get('/calls', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const calls = getCallHistory(db, limit);
    res.json(calls);
  });

  router.get('/calls/:id', (req, res) => {
    const call = getCallById(db, req.params.id);
    if (!call) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }
    res.json(call);
  });

  router.get('/stats', (_req, res) => {
    const stats = getCallStats(db);
    res.json(stats);
  });

  router.get('/whitelist', (_req, res) => {
    const entries = getWhitelist(db);
    res.json(entries);
  });

  router.post('/whitelist', (req, res) => {
    const { phone_number, name, relationship } = req.body;

    if (!phone_number) {
      res.status(400).json({ error: 'phone_number is required' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const entry = {
      id: crypto.randomUUID(),
      phone_number,
      name,
      relationship: relationship || null,
    };

    addToWhitelist(db, entry);
    res.status(201).json(entry);
  });

  router.delete('/whitelist/:id', (req, res) => {
    const deleted = removeFromWhitelist(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Whitelist entry not found' });
      return;
    }
    res.json({ success: true });
  });

  router.get('/security-context', (_req, res) => {
    res.json(getSecurityContext(db));
  });

  router.post('/security-context', (req, res) => {
    const { fact } = req.body;
    if (!fact || !fact.trim()) {
      res.status(400).json({ error: 'fact is required' });
      return;
    }
    const entry = {
      id: crypto.randomUUID(),
      fact: fact.trim(),
      created_at: new Date().toISOString(),
    };
    addSecurityFact(db, entry);
    res.status(201).json(entry);
  });

  router.delete('/security-context/:id', (req, res) => {
    const deleted = removeSecurityFact(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Security fact not found' });
      return;
    }
    res.json({ success: true });
  });

  router.get('/alerts/config', (_req, res) => {
    if (!config) {
      res.status(503).json({ error: 'Config not available' });
      return;
    }
    res.json({ topic: config.ntfyTopic, recipientName: config.recipientName });
  });

  router.post('/alerts/test', async (_req, res) => {
    if (!config) {
      res.status(503).json({ error: 'Config not available' });
      return;
    }
    try {
      await sendAlert(
        {
          id: 'test',
          caller_number: '+15550000000',
          caller_name: 'Test Alert',
          outcome: 'blocked',
          confidence_score: 0.05,
          risk_reasoning: 'This is a test alert from GuardLine.',
          stated_relationship: null,
          stated_purpose: null,
          knew_recipient_name: null,
          transcript: null,
          created_at: new Date().toISOString(),
        },
        { ntfyTopic: config.ntfyTopic, recipientName: config.recipientName },
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
