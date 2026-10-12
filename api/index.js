const path = require('node:path');

let hubServer;
function getHubServer() {
  if (!hubServer) {
    try {
      const { createHubServer } = require('../lib/hub');
      hubServer = createHubServer({ baseDir: path.resolve(__dirname, '..') });
    } catch (err) {
      console.error('[getHubServer fatal initialization error]', err);
      throw err;
    }
  }
  return hubServer;
}

module.exports = async function handler(req, res) {
  try {
    const originalUrl = req.headers['x-matched-path'] || req.url || '/';
    if (req.url === '/api/index.js' || req.url === '/api/index' || req.url === '/api') {
      req.url = originalUrl;
    }
    return await getHubServer().handler(req, res);
  } catch (error) {
    console.error('[Vercel API Handler Error]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SERVERLESS_FUNCTION_ERROR', message: error.message, stack: error.stack }));
    }
  }
};
