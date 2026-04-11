import { Router } from 'express';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getCallHistory, getCallById, getCallStats, getWhitelist, addToWhitelist, removeFromWhitelist } from './db.js';

export function createApiRouter(db: Database.Database): Router {
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

  return router;
}
