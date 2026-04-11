import express from 'express';
import type { Express } from 'express';
import { createServer, type Server } from 'http';
import Database from 'better-sqlite3';
import cors from 'cors';
import type { Config } from './config.js';
import { initDb } from './db.js';
import { handleIncomingCall, handleCallStatus } from './twilio.js';
import { setupWebSocketServer } from './ws-handler.js';
import { createApiRouter } from './api.js';

export function createApp(db?: Database.Database, config?: Config): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files from public directory
  app.use(express.static('public'));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (db && config) {
    app.post('/voice/incoming', (req, res) => handleIncomingCall(req, res, db, config));
    app.post('/voice/status', (req, res) => handleCallStatus(req, res));
    app.use('/api', createApiRouter(db));
  }

  return app;
}

export function createServer_(db: Database.Database, config: Config): Server {
  const app = createApp(db, config);
  const server = createServer(app);
  setupWebSocketServer(server, db, config);
  return server;
}

async function main() {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  const db = new Database('guardline.db');
  initDb(db);
  const server = createServer_(db, config);

  // Graceful shutdown handler
  const shutdown = () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => {
      console.log('✓ HTTP server closed');
      db.close();
      console.log('✓ Database closed');
      console.log('👋 Goodbye!');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('⚠️  Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, () => {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║            🛡️  GuardLine Active 🛡️               ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log(`\n📞 Twilio Number:    ${config.twilioPhoneNumber}`);
    console.log(`🌐 Dashboard:        http://localhost:${config.port}`);
    console.log(`🔌 API Endpoint:     http://localhost:${config.port}/api`);
    console.log(`💚 Health Check:     http://localhost:${config.port}/health`);
    console.log(`\n👤 Protected User:   ${config.recipientName}`);
    console.log(`📱 User Phone:       ${config.recipientPhoneNumber}`);
    console.log(`🚨 Emergency:        ${config.emergencyContactPhone}`);
    console.log(`\n✅ Server ready! Press Ctrl+C to stop.\n`);
  });
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
