import Database from 'better-sqlite3';
import type { CallRecord, WhitelistEntry } from './types.js';

export function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      caller_number TEXT NOT NULL,
      caller_name TEXT,
      stated_relationship TEXT,
      stated_purpose TEXT,
      knew_recipient_name BOOLEAN,
      confidence_score REAL,
      risk_reasoning TEXT,
      outcome TEXT NOT NULL,
      transcript TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      id TEXT PRIMARY KEY,
      phone_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      relationship TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS security_context (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export interface SecurityFact {
  id: string;
  fact: string;
  created_at: string;
}

export function getSecurityContext(db: Database.Database): SecurityFact[] {
  return db.prepare('SELECT * FROM security_context ORDER BY created_at ASC').all() as SecurityFact[];
}

export function addSecurityFact(db: Database.Database, entry: SecurityFact): void {
  db.prepare('INSERT INTO security_context (id, fact, created_at) VALUES (@id, @fact, @created_at)').run(entry);
}

export function removeSecurityFact(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM security_context WHERE id = ?').run(id);
  return result.changes > 0;
}

export function logCall(db: Database.Database, call: CallRecord): void {
  db.prepare(`
    INSERT INTO calls (id, caller_number, caller_name, stated_relationship, stated_purpose,
      knew_recipient_name, confidence_score, risk_reasoning, outcome, transcript, created_at)
    VALUES (@id, @caller_number, @caller_name, @stated_relationship, @stated_purpose,
      @knew_recipient_name, @confidence_score, @risk_reasoning, @outcome, @transcript, @created_at)
  `).run({
    ...call,
    knew_recipient_name: call.knew_recipient_name == null ? null : call.knew_recipient_name ? 1 : 0,
  });
}

export function getCallHistory(db: Database.Database, limit?: number): CallRecord[] {
  if (limit) {
    return db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?').all(limit) as CallRecord[];
  }
  return db.prepare('SELECT * FROM calls ORDER BY created_at DESC').all() as CallRecord[];
}

export function getCallById(db: Database.Database, id: string): CallRecord | null {
  return (db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as CallRecord) ?? null;
}

export function addToWhitelist(db: Database.Database, entry: WhitelistEntry): void {
  db.prepare(`
    INSERT OR REPLACE INTO whitelist (id, phone_number, name, relationship)
    VALUES (@id, @phone_number, @name, @relationship)
  `).run(entry);
}

export function checkWhitelist(db: Database.Database, phoneNumber: string): WhitelistEntry | null {
  return (db.prepare('SELECT * FROM whitelist WHERE phone_number = ?').get(phoneNumber) as WhitelistEntry) ?? null;
}

export function getWhitelist(db: Database.Database): WhitelistEntry[] {
  return db.prepare('SELECT * FROM whitelist ORDER BY name').all() as WhitelistEntry[];
}

export function removeFromWhitelist(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM whitelist WHERE id = ?').run(id);
  return result.changes > 0;
}

export interface CallStats {
  total: number;
  forwarded: number;
  blocked: number;
  held: number;
  whitelisted: number;
}

export function getCallStats(db: Database.Database): CallStats {
  const rows = db.prepare(
    "SELECT outcome, COUNT(*) as count FROM calls GROUP BY outcome"
  ).all() as { outcome: string; count: number }[];

  const stats: CallStats = { total: 0, forwarded: 0, blocked: 0, held: 0, whitelisted: 0 };
  for (const row of rows) {
    const key = row.outcome as keyof Omit<CallStats, 'total'>;
    if (key in stats) {
      stats[key] = row.count;
    }
    stats.total += row.count;
  }
  return stats;
}
