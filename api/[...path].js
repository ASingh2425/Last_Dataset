const fs = require('node:fs');
const path = require('node:path');

function getBaseDir() {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    __dirname,
    process.env.LAMBDA_TASK_ROOT
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'config', 'zones.json'))) {
      return dir;
    }
  }
  return process.cwd();
}

let hubServer;
function getHubServer() {
  if (!hubServer) {
    try {
      const { createHubServer } = require('../lib/hub');
      const baseDir = getBaseDir();
      hubServer = createHubServer({ baseDir });
    } catch (err) {
      console.error('[getHubServer fatal initialization error]', err);
      throw err;
    }
  }
  return hubServer;
}

module.exports = async function vercelHandler(req, res) {
  try {
    const requestUrl = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const pathname = requestUrl.pathname;
    if (pathname === '/api/hub') requestUrl.pathname = '/';
    else if (pathname.startsWith('/api/hub/')) requestUrl.pathname = pathname.slice('/api/hub'.length) || '/';
    req.url = requestUrl.pathname + requestUrl.search;
    return await getHubServer().handler(req, res);
  } catch (error) {
    console.error('[vercelHandler error]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SERVERLESS_FUNCTION_ERROR', message: error.message, stack: error.stack }));
    }
  }
};
