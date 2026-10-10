const path = require('node:path');
const { createHubServer } = require('../lib/hub');

// Keep one handler per warm function instance. Vercel rewrites all app paths here,
// then this adapter restores the original URL so the same tested router serves it.
let hubServer;
function getHubServer() {
  if (!hubServer) {
    hubServer = createHubServer({ baseDir: path.resolve(__dirname, '..') });
  }
  return hubServer;
}

module.exports = function vercelHandler(req, res) {
  const requestUrl = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  if (pathname === '/api/hub') requestUrl.pathname = '/';
  else if (pathname.startsWith('/api/hub/')) requestUrl.pathname = pathname.slice('/api/hub'.length) || '/';
  req.url = requestUrl.pathname + requestUrl.search;
  return getHubServer().emit('request', req, res);
};
