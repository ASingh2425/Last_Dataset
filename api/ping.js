module.exports = (req, res) => {
  try {
    const hub = require('../lib/hub');
    const store = require('../lib/store');
    const config = require('../lib/config');
    const sc = require('../lib/supabaseClient');
    const hubServer = hub.createHubServer();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      hasHub: !!hub,
      hasStore: !!store,
      hasConfig: !!config,
      hasSupabaseClient: !!sc,
      serverInitialized: !!hubServer,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        VERCEL: process.env.VERCEL,
        PWD: process.cwd()
      }
    }, null, 2));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'diagnostic_error',
      message: err.message,
      stack: err.stack
    }, null, 2));
  }
};
