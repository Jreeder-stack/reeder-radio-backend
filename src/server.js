import 'dotenv/config';
import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { initializeDatabase } from './db/index.js';

async function start() {
  validateEnv();
  
  try {
    await initializeDatabase();
    console.log('Database ready');
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }
  
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Server running on port ${config.port}`);
  });
}

start().catch(console.error);
