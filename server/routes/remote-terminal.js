/**
 * Darkhan — Remote Terminal Routes
 * GET  /api/remote-terminal/nodes              — list remote nodes with reachability
 * GET  /api/remote-terminal/nodes/:nodeId/sessions — list active sessions on a remote node
 * GET  /api/remote-terminal/status             — proxy status (active sessions)
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/remote-terminal/nodes — list remote nodes with reachability status
router.get('/nodes', async (req, res) => {
  const config = req.app.locals.config || {};
  const remoteNodes = (config.terminalRelay && config.terminalRelay.remoteNodes) || {};
  const tlsConfig = config.tls || {};

  const nodes = await Promise.all(
    Object.entries(remoteNodes).map(async ([nodeId, nodeCfg]) => {
      const hasApiKey = !!(process.env[nodeCfg.apiKeyEnvVar] && !process.env[nodeCfg.apiKeyEnvVar].startsWith('PLACEHOLDER'));
      let reachable = false;
      let latencyMs = null;

      if (hasApiKey) {
        try {
          const start = Date.now();
          reachable = await pingNode(nodeCfg.url, tlsConfig);
          latencyMs = Date.now() - start;
        } catch (e) {
          // unreachable
        }
      }

      return {
        id: nodeId,
        label: nodeCfg.label,
        agentId: nodeCfg.agentId,
        url: nodeCfg.url,
        hasApiKey,
        reachable,
        latencyMs
      };
    })
  );

  res.json({ nodes });
});

// GET /api/remote-terminal/nodes/:nodeId/sessions — list sessions on a remote node
router.get('/nodes/:nodeId/sessions', async (req, res) => {
  const config = req.app.locals.config || {};
  const remoteNodes = (config.terminalRelay && config.terminalRelay.remoteNodes) || {};
  const nodeId = req.params.nodeId;
  const nodeCfg = remoteNodes[nodeId];

  if (!nodeCfg) {
    return res.status(404).json({ error: `Unknown node: ${nodeId}` });
  }

  const apiKey = process.env[nodeCfg.apiKeyEnvVar];
  if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
    return res.status(503).json({ error: `No API key for ${nodeCfg.label}` });
  }

  try {
    const data = await fetchRemote(`${nodeCfg.url}/api/terminal`, apiKey, config.tls);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: `Cannot reach ${nodeCfg.label}: ${e.message}` });
  }
});

// GET /api/remote-terminal/status — proxy session status
router.get('/status', (req, res) => {
  const proxy = req.app.locals.remoteTerminalProxy;
  if (!proxy) {
    return res.status(503).json({ error: 'Remote terminal proxy not initialized' });
  }
  res.json(proxy.getStatus());
});

// --- Helpers ---

function pingNode(baseUrl, tlsConfig) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/diagnostic', baseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      timeout: 5000
    };

    if (url.protocol === 'https:' && tlsConfig.enabled) {
      try {
        opts.ca = fs.readFileSync(tlsConfig.ca);
        opts.cert = fs.readFileSync(tlsConfig.cert);
        opts.key = fs.readFileSync(tlsConfig.key);
        opts.rejectUnauthorized = true;
      } catch (e) {
        return reject(e);
      }
    }

    const transport = url.protocol === 'https:' ? https : require('http');
    const req = transport.request(opts, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function fetchRemote(url, apiKey, tlsConfig) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      timeout: 5000,
      headers: {
        'X-API-Key': apiKey,
        'X-Darkhan-Client': 'true'
      }
    };

    if (parsed.protocol === 'https:' && tlsConfig && tlsConfig.enabled) {
      try {
        opts.ca = fs.readFileSync(tlsConfig.ca);
        opts.cert = fs.readFileSync(tlsConfig.cert);
        opts.key = fs.readFileSync(tlsConfig.key);
        opts.rejectUnauthorized = true;
      } catch (e) {
        return reject(e);
      }
    }

    const transport = parsed.protocol === 'https:' ? https : require('http');
    const req = transport.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Invalid JSON from remote: ${body.slice(0, 100)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

module.exports = router;
