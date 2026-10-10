const fs = require('node:fs');
const path = require('node:path');
const { createHubServer } = require('./lib/hub');

function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['\"])(.*)\1$/, '$2');
  }
}
if (require.main === module) {
  loadEnvFile();
  const port = Number(process.env.PORT || 4179);
  const host = process.env.HOST || '127.0.0.1';
  const server = createHubServer();
  server.listen(port, host, () => {
    console.log(`THE LAST DATASET Map Hub listening at http://${host}:${port}`);
    console.log(`Environment: ${server.hub.isProduction ? 'production' : 'development'} · Dev simulation: ${server.hub.devToolsEnabled ? 'ENABLED' : 'disabled'}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
module.exports = { createHubServer };
