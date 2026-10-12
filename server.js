const fs = require('node:fs');
const path = require('node:path');
const { createHubServer } = require('./lib/hub');

function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

let hubServer;
function getHubServer() {
  if (!hubServer) {
    loadEnvFile();
    hubServer = createHubServer({ baseDir: __dirname });
  }
  return hubServer;
}

const handler = (req, res) => {
  let targetUrl = req.headers['x-matched-path'] || req.headers['x-vercel-matched-path'] || req.headers['x-rewrite-url'] || req.headers['x-forwarded-uri'];
  if (!targetUrl && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      if (parsed.searchParams.has('_path')) {
        targetUrl = parsed.searchParams.get('_path');
      }
    } catch (_) {}
  }
  if (targetUrl) {
    req.url = targetUrl;
  }
  return getHubServer().handler(req, res);
};

if (require.main === module) {
  loadEnvFile();
  const port = Number(process.env.PORT || 4179);
  const host = process.env.HOST || '127.0.0.1';
  const server = getHubServer();
  server.listen(port, host, () => {
    console.log(`THE LAST DATASET Map Hub listening at http://${host}:${port}`);
    console.log(`Environment: ${server.hub.isProduction ? 'production' : 'development'} · Dev simulation: ${server.hub.devToolsEnabled ? 'ENABLED' : 'disabled'}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = handler;
module.exports.default = handler;
module.exports.createHubServer = createHubServer;
module.exports.handler = handler;
