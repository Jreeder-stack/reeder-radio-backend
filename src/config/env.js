export const config = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  databaseUrl: process.env.DATABASE_URL,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  cadUrl: process.env.CAD_URL,
  cadApiKey: process.env.CAD_API_KEY,
};

export function validateEnv() {
  const required = ['DATABASE_URL'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
  }
  
  return missing.length === 0;
}
