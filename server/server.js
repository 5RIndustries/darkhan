// Load .env — requires Node 20.12+ (process.loadEnvFile)
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch (_) { /* .env may not exist */ }
} else {
  console.error('[Darkhan] Node 20.12+ required (process.loadEnvFile not available). Current: ' + process.version);
  process.exit(1);
}
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Darkhan services
const { ActivityLog } = require('./services/activity-log');
const { CostTracker } = require('./services/cost-tracker');
const { RateLimiter } = require('./services/rate-limiter');
const { LLMService } = require('./services/llm');
const { WorkerRuntime } = require('./services/worker-runtime');
const { SecurityService } = require('./services/security');
const { IntegrityService } = require('./services/integrity');
const { ClaimVerifierService } = require('./services/claim-verifier');
const { GroundTruthRegistry } = require('./services/ground-truth');
const { KeychainService } = require('./services/keychain');
const { ModelVerifier } = require('./services/model-verifier');
const { TerminalRelay } = require('./services/terminal-relay');
const { UnifiedClaudeSession } = require('./services/unified-claude');
const { InstanceIdentity } = require('./services/instance-identity');
const { BehavioralBaseline } = require('./services/behavioral-baseline');
const { MaintenanceService } = require('./services/maintenance');
const SecretsCrypto = require('./services/secrets-crypto');

// Load config
const CONFIG_PATH = path.join(__dirname, 'darkhan.config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  console.log(`[Darkhan] Config loaded: ${config.instance?.brandName || 'Darkhan'}`);
} catch (e) {
  console.error(`[Darkhan] FATAL: Could not load ${CONFIG_PATH}:`, e.message);
  process.exit(1);
}

const app = express();

// --- VPS Hardening: Trust proxy for reverse proxy deployments (Caddy, nginx, Cloudflare) ---
const TRUST_PROXY = process.env.DARKHAN_TRUST_PROXY || config.instance?.trustProxy || false;
if (TRUST_PROXY) {
  app.set('trust proxy', TRUST_PROXY === 'true' ? 1 : TRUST_PROXY);
}

// [DARKHAN SECURITY] mTLS: Start HTTPS server if TLS config is enabled.
// When TLS is enabled, the server requires valid client certificates signed by our CA
// for all federation API calls. The web UI (localhost) can still use HTTP.
const resolveTlsPath = (p) => p ? p.replace('~', process.env.HOME) : null;
let server;
if (config.tls?.enabled) {
  try {
    const tlsOpts = {
      ca: fs.readFileSync(resolveTlsPath(config.tls.ca)),
      cert: fs.readFileSync(resolveTlsPath(config.tls.cert)),
      key: fs.readFileSync(resolveTlsPath(config.tls.key)),
      requestCert: true,           // Ask clients for their certificate
      rejectUnauthorized: true,    // [C-2 FIX] Reject connections without valid CA-signed cert
    };
    server = https.createServer(tlsOpts, app);
    console.log('[Darkhan] HTTPS server with mTLS — client certificates will be verified for federation routes');
  } catch (e) {
    console.error(`[Darkhan] FATAL: TLS enabled but certificates failed to load: ${e.message}`);
    process.exit(1);
  }
} else {
  server = http.createServer(app);
}

// --- VPS Hardening: WebSocket origin validation ---
const ALLOWED_ORIGINS = (process.env.DARKHAN_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || `http${config.tls?.enabled ? 's' : ''}://localhost:${config.instance?.port || 3001}`).split(',').map(s => s.trim());

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS.length === 1 ? ALLOWED_ORIGINS[0] : ALLOWED_ORIGINS,
    credentials: true
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    // Allow requests with no origin (non-browser clients: CLI agents, API keys, curl)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin === o || o === '*')) return callback(null, true);
    console.warn(`[Security] WebSocket connection rejected: origin "${origin}" not in allowed list [${ALLOWED_ORIGINS.join(', ')}]`);
    callback('Origin not allowed', false);
  }
});

const PORT = process.env.PORT || config.instance?.port || 3001;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const DB_PATH = path.join(__dirname, 'db', 'darkhan.db');
const SECRETS_DB_PATH = path.join(__dirname, 'db', 'secrets.db');

// SECURITY: SESSION_SECRET is required — no fallback, no default
if (!process.env.SESSION_SECRET) {
  console.error('[Darkhan] FATAL: SESSION_SECRET environment variable is not set.');
  console.error('[Darkhan] Set SESSION_SECRET in .env before starting. Refusing to start with a hardcoded fallback.');
  process.exit(1);
}

// Middleware
// [C-3 FIX] Security headers
app.use(helmet({
  contentSecurityPolicy: false, // SPA manages its own CSP
  crossOriginEmbedderPolicy: false, // Allow loading from same origin
}));

// [M-5 FIX] Reject wildcard CORS origin when credentials are enabled
const corsOrigin = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;
if (corsOrigin === '*') {
  console.error('[Darkhan] FATAL: CORS_ORIGIN=* is not allowed with credentials. Set a specific origin.');
  process.exit(1);
}
app.use(cors({ origin: corsOrigin, credentials: true }));

// [C-3 FIX] HTTP rate limiting — prevents DoS and brute-force on all endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 120,              // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a minute.' },
});
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,               // 30 message posts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message rate limit exceeded.' },
});
app.use('/api', apiLimiter);
app.use('/api/messages', messageLimiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Persistent session store — survives server restarts
const SQLiteStore = require('./services/session-store')(session);
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, 'db'),
    concurrentDB: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.DARKHAN_HTTPS === 'true' || config.tls?.enabled || false,
    httpOnly: true,
    sameSite: (process.env.DARKHAN_HTTPS === 'true' || config.tls?.enabled) ? 'strict' : 'lax',
    maxAge: 8 * 60 * 60 * 1000  // 8 hours
  }
}));

// [DARKHAN SECURITY] CSRF protection — require custom header on state-changing requests
// Browsers enforce that custom headers can't be sent cross-origin without CORS preflight.
// API-key-authenticated requests are already CSRF-safe (the key acts as the token).
app.use((req, res, next) => {
  // Only check state-changing methods
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();

  // API key auth is inherently CSRF-safe — skip check
  if (req.headers['x-api-key']) return next();

  // Login endpoint must be exempt (user hasn't authenticated yet, no session to exploit)
  if (req.path === '/api/auth/login') return next();

  // For session-authenticated requests, require the custom header
  if (req.headers['x-darkhan-client'] !== 'true') {
    console.warn(`[Security] CSRF check failed: missing X-Darkhan-Client header on ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'CSRF validation failed — missing X-Darkhan-Client header' });
  }

  next();
});

// Serve static client files
app.use(express.static(path.join(__dirname, '../client')));

// Auto-seed from config
function runSeedIfEmpty(database) {
  database.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
    if (err) return console.error('[Darkhan] Seed check error:', err.message);
    if (row.count === 0) {
      console.log('[Darkhan] No users — running auto-seed...');
      const { execSync } = require('child_process');
      try {
        execSync(`"${process.execPath}" "${path.join(__dirname, 'db', 'seed.js')}"`, {
          stdio: 'inherit', cwd: __dirname
        });
        console.log('[Darkhan] Auto-seed complete.');
      } catch (e) {
        console.error('[Darkhan] Auto-seed failed:', e.message);
      }
    }
  });
}

// Database — schema must be applied before services initialize
const db = new sqlite3.Database(DB_PATH);
console.log('[Darkhan] Connected to database.');
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA busy_timeout=5000');

// Secrets database — credential isolation (API keys, password hashes, PINs)
// Workers NEVER receive this handle. Only auth middleware and routes get access.
const secretsDb = new sqlite3.Database(SECRETS_DB_PATH);
console.log('[Darkhan] Connected to secrets database.');
secretsDb.run('PRAGMA journal_mode=WAL');
secretsDb.run('PRAGMA busy_timeout=5000');

// Helper: apply SQL schema to a database, handling trigger bodies
function applySchema(database, schemaPath, label) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const safeSql = schema.replace(/BEGIN\s[\s\S]*?END;/gm, (match) => match.replace(/;/g, '##SEMI##'));
  const statements = safeSql.split(';').map(s => s.replace(/##SEMI##/g, ';').trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    database.run(stmt + ';', (err) => {
      if (err && !err.message.includes('already exists') && !err.message.includes('duplicate column name')) {
        console.error(`[Darkhan] ${label} schema statement error:`, err.message);
      }
    });
  }
  console.log(`[Darkhan] ${label} schema applied.`);
}

// Apply schemas synchronously via serialize
db.serialize(() => {
  applySchema(db, path.join(__dirname, 'db', 'schema.sql'), 'Main');
  // Schema migrations — add columns that may not exist in older installations
  db.run("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/New_York'", (err) => {
    if (err && !err.message.includes('duplicate column')) console.error('[Migration]', err.message);
  });
  db.run("ALTER TABLE users ADD COLUMN execution_tier TEXT DEFAULT 'supervised'", (err) => {
    if (err && !err.message.includes('duplicate column')) console.error('[Migration]', err.message);
  });
  runSeedIfEmpty(db);
});

secretsDb.serialize(() => {
  applySchema(secretsDb, path.join(__dirname, 'db', 'secrets-schema.sql'), 'Secrets');

  // Enforce 600 permissions on secrets.db
  try {
    fs.chmodSync(SECRETS_DB_PATH, 0o600);
    console.log('[Darkhan] secrets.db permissions set to 600');
  } catch (e) {
    console.warn('[Darkhan] Could not set secrets.db permissions:', e.message);
  }

  // Migrate unencrypted API keys to encrypted-at-rest (runs after schema applied)
  // Use a dummy SELECT inside serialize to ensure all prior statements have completed
  secretsDb.get('SELECT 1', [], () => {
    try {
      const sc = new SecretsCrypto(process.env.SESSION_SECRET);
      secretsDb.all('SELECT user_id, api_key, api_key_hmac FROM credentials', [], (err, rows) => {
        if (err) { console.error('[Darkhan] Cannot read credentials for encryption migration:', err.message); return; }
        let migrated = 0;
        for (const row of rows || []) {
          if (row.api_key && !sc.isEncrypted(row.api_key)) {
            const encrypted = sc.encrypt(row.api_key);
            const hmac = sc.hmac(row.api_key);
            secretsDb.run('UPDATE credentials SET api_key = ?, api_key_hmac = ? WHERE user_id = ?',
              [encrypted, hmac, row.user_id]);
            migrated++;
          } else if (row.api_key && !row.api_key_hmac) {
            const plainKey = sc.decrypt(row.api_key);
            const hmac = sc.hmac(plainKey);
            secretsDb.run('UPDATE credentials SET api_key_hmac = ? WHERE user_id = ?', [hmac, row.user_id]);
            migrated++;
          }
        }
        if (migrated > 0) {
          console.log(`[Darkhan] Encrypted ${migrated} API key(s) at rest.`);
        } else {
          console.log('[Darkhan] All API keys already encrypted at rest.');
        }
      });
    } catch (e) {
      console.error('[Darkhan] Encryption migration error:', e.message);
    }
  });
});

// Initialize Darkhan services (tables guaranteed to exist after serialize)
const activityLog = new ActivityLog({ db, instanceId: config.federation?.instanceId || 'standalone' });
const costTracker = new CostTracker({ db });
const rateLimiter = new RateLimiter({ config, activityLog });
const llmService = new LLMService({ rateLimiter, costTracker, activityLog, config });
const securityService = new SecurityService({ db, activityLog, config, llmService });
const integrityService = new IntegrityService({ db, activityLog, securityService, config, secretsDb });
const vaultPath = (config.vault?.path || '~/darkhan-vault').replace('~', process.env.HOME);
const claimVerifier = new ClaimVerifierService({ vaultPath, db, activityLog });
const groundTruth = new GroundTruthRegistry({ db, activityLog });
const behavioralBaseline = new BehavioralBaseline({ db, activityLog, io });

// Schedule daily baseline update at 0200 ET
setInterval(() => {
  const hour = new Date().toLocaleString('en-US', { timeZone: config.instance?.timezone || 'America/New_York', hour: 'numeric', hour12: false });
  if (parseInt(hour) === 2) {
    behavioralBaseline.updateAllBaselines().then(result => {
      if (result && result.updated > 0) {
        console.log(`[BehavioralBaseline] Updated ${result.updated} agent baseline(s)`);
      }
    }).catch(e => console.error('[BehavioralBaseline] Update error:', e.message));
  }
}, 60 * 60 * 1000); // Check hourly, run at 2 AM

// Run initial baseline update on startup (non-blocking)
behavioralBaseline.updateAllBaselines().catch(() => {});

// Initialize secrets encryption (derives key from SESSION_SECRET via HKDF)
const secretsCrypto = new SecretsCrypto(process.env.SESSION_SECRET);
console.log('[Darkhan] Secrets encryption initialized (AES-256-GCM).');

// NOTE: API key encryption migration runs inside secretsDb.serialize() above

// Make services available to routes
app.locals.db = db;
app.locals.secretsDb = secretsDb;  // Credential-isolated DB — NOT passed to workers
app.locals.secretsCrypto = secretsCrypto;
app.locals.io = io;
app.locals.config = config;
app.locals.activityLog = activityLog;
app.locals.costTracker = costTracker;
app.locals.rateLimiter = rateLimiter;
app.locals.llmService = llmService;
app.locals.securityService = securityService;
app.locals.integrityService = integrityService;
app.locals.behavioralBaseline = behavioralBaseline;
app.locals.claimVerifier = claimVerifier;
app.locals.groundTruth = groundTruth;

// Wire ground truth into claim verifier (both must be initialized first)
claimVerifier.groundTruth = groundTruth;

// macOS Keychain integration (Layer 3 security)
const keychainService = new KeychainService({ activityLog });
app.locals.keychainService = keychainService;

// LLM model integrity verification (hostile model defense)
const modelVerifier = new ModelVerifier({ activityLog, config });
modelVerifier.verifyConfiguredModels().catch(e =>
  console.error('[ModelVerifier] Verification error:', e.message)
);

// Existing routes (evolved from DARYL)
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const taskRoutes = require('./routes/tasks');
const healthRoutes = require('./routes/health');
const approvalsRoutes = require('./routes/approvals');
const quarantineRoutes = require('./routes/quarantine');
const contextRoutes = require('./routes/context');

// Auth middleware for inline route protection
const { requireAuth: secReqAuth } = require('./middleware/auth');

app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/quarantine', quarantineRoutes);
app.use('/api/context', contextRoutes);

// Vault (Knowledge Base)
const vaultRoutes = require('./routes/vault');
app.use('/api/vault', vaultRoutes);

// --- Darkhan API endpoints ---

// Cost tracking
app.get('/api/costs/daily', secReqAuth, async (req, res) => {
  try { res.json({ summary: await costTracker.getDailySummary(req.query.date) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/costs/total', secReqAuth, async (req, res) => {
  try { res.json({ summary: await costTracker.getTotalSummary() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Rate limiter status
app.get('/api/rates', secReqAuth, (req, res) => {
  res.json(rateLimiter.getSummary());
});

// Activity log
app.get('/api/activity', secReqAuth, async (req, res) => {
  try {
    const { actor, action, limit, since } = req.query;
    const events = await activityLog.getRecent({
      actor, action, limit: parseInt(limit) || 50, since
    });
    res.json({ events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activity log hash chain verification
app.get('/api/activity/verify', secReqAuth, async (req, res) => {
  try { res.json(await activityLog.verify()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Chain head — lightweight endpoint for cross-instance verification (federation)
app.get('/api/activity/chain-head', secReqAuth, async (req, res) => {
  try { res.json(await activityLog.getChainHead()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Chain statistics — dashboard-friendly summary
app.get('/api/activity/stats', secReqAuth, async (req, res) => {
  try { res.json(await activityLog.getChainStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Defense spacers — list CRISPR-style entries for federation propagation
app.get('/api/activity/spacers', secReqAuth, async (req, res) => {
  try {
    const { category, since, limit } = req.query;
    const spacers = await activityLog.getSpacers({
      category, since, limit: parseInt(limit) || 100,
    });
    res.json({ spacers, instanceId: config.federation?.instanceId || 'standalone' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [H-4 FIX] Ingest remote spacer from federated peer (federation endpoint)
// Restricted to admin or federation-authenticated requests only
app.post('/api/activity/spacers/ingest', secReqAuth, (req, res) => {
  // [C-1 FIX] Only admins can inject spacers. Federation ingestion will require
  // mTLS peer cert verification when federation ships — never a spoofable header.
  const isAdmin = req.session?.role === 'admin';
  if (!isAdmin) {
    activityLog.append({ actor: 'darkhan_security', action: 'spacer_injection_blocked', target: req.authenticatedId, details: 'Non-admin attempted spacer ingestion' });
    return res.status(403).json({ error: 'Only admins or federation peers can ingest spacers' });
  }
  const { category, signature, description, sourceInstanceId, sourceEntryId } = req.body;
  if (!category || !signature || !sourceInstanceId) {
    return res.status(400).json({ error: 'category, signature, and sourceInstanceId required' });
  }
  const chainHash = activityLog.ingestRemoteSpacer({
    category, signature, description, sourceInstanceId, sourceEntryId,
  });
  if (chainHash) {
    res.json({ ingested: true, chainHash });
  } else {
    res.status(400).json({ error: 'Invalid spacer data' });
  }
});

// === Ground Truth Registry ===

// List all ground truths (optionally filtered by category)
app.get('/api/ground-truth', secReqAuth, async (req, res) => {
  try {
    const { category } = req.query;
    const truths = await groundTruth.getAll({ category });
    res.json({ truths, count: truths.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get a single ground truth by key
app.get('/api/ground-truth/:key', secReqAuth, (req, res) => {
  const truth = groundTruth.get(req.params.key);
  if (!truth) return res.status(404).json({ error: 'Ground truth not found' });
  res.json(truth);
});

// Register or update a ground truth (admin only)
app.post('/api/ground-truth', secReqAuth, async (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can register ground truths' });
  }
  try {
    const { key, category, value, unit, source, aliases, notes } = req.body;
    const result = await groundTruth.register({
      key, category, value, unit, source,
      verifiedBy: req.session.userId,
      aliases: aliases || [],
      notes,
    });
    res.json({ ok: true, truth: result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Deprecate a ground truth (admin only)
app.post('/api/ground-truth/:key/deprecate', secReqAuth, async (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can deprecate ground truths' });
  }
  try {
    const result = await groundTruth.deprecate(req.params.key, req.body.reason || 'No reason given', req.session.userId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Generate agent brief from ground truths
app.get('/api/ground-truth/brief/text', secReqAuth, async (req, res) => {
  try {
    const brief = await groundTruth.generateBrief();
    res.type('text/markdown').send(brief);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check a text against ground truths (for testing/debugging)
app.post('/api/ground-truth/check', secReqAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const results = groundTruth.checkMessage(text);
  res.json({ results, count: results.length });
});

// Zero-auth diagnostic endpoint — agents verify system state without credentials
// Returns ONLY non-sensitive operational state: process health, session counts, worker status
// See OPERATOR-TESTING.md for the principle: "Test through observable side effects, not authentication"
app.get('/api/diagnostic', (req, res) => {
  const diag = {
    server: 'running',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    workers: [],
    claudeSession: { active: false },
    reviewGate: { enabled: false },
  };

  if (app.locals.workerRuntime) {
    diag.workers = app.locals.workerRuntime.getStatus().map(w => ({
      name: w.name,
      status: w.status,
      running: w.running || null,
      disabled: w.disabled || false,
    }));
  }

  if (app.locals.unifiedClaude) {
    const uStatus = app.locals.unifiedClaude.getStatus();
    diag.claudeSession = {
      active: uStatus.activeSessions > 0,
      count: uStatus.activeSessions,
      storedSessions: uStatus.storedSessions,
    };
  }

  if (app.locals.reviewGate) {
    const rg = app.locals.reviewGate.getStatus();
    diag.reviewGate = { enabled: rg.enabled, stats: rg.stats };
  }

  // OEP: Observation-Evidence Protocol status
  if (app.locals.workerRuntime?.oep) {
    diag.oep = { active: true };
  }

  // AEP: Action-Evidence Protocol status
  if (app.locals.workerRuntime?.aep) {
    diag.aep = { active: true, activeTraces: app.locals.workerRuntime.aep.traces.size };
  }

  // Intentionally excludes: credentials, API keys, session tokens,
  // database contents, file paths, user info, config details
  res.json(diag);
});

// Instance identity (public key for federation trust)
app.get('/api/identity', secReqAuth, (req, res) => {
  if (app.locals.instanceIdentity) {
    res.json(app.locals.instanceIdentity.getInfo());
  } else {
    res.json({ error: 'Identity not initialized' });
  }
});

// Terminal sessions status
app.get('/api/terminal', secReqAuth, (req, res) => {
  if (app.locals.terminalRelay) {
    res.json(app.locals.terminalRelay.getStatus());
  } else {
    res.json({ activeSessions: 0, sessions: [] });
  }
});

// Worker runtime status
app.get('/api/workers', secReqAuth, (req, res) => {
  if (app.locals.workerRuntime) {
    res.json({ workers: app.locals.workerRuntime.getStatus() });
  } else {
    res.json({ workers: [], message: 'Worker runtime not initialized' });
  }
});

// Behavioral baselines API
app.get('/api/baselines', secReqAuth, async (req, res) => {
  if (!app.locals.behavioralBaseline) return res.json({ baselines: [] });
  const baselines = await app.locals.behavioralBaseline.getAllBaselines();
  res.json({ baselines });
});

app.post('/api/baselines/check/:agentId', secReqAuth, async (req, res) => {
  if (!app.locals.behavioralBaseline) return res.json({ anomalies: [] });
  const result = await app.locals.behavioralBaseline.checkAgent(req.params.agentId);
  res.json(result);
});

// [ASI08] Per-agent enable/disable toggle (admin only)
app.post('/api/workers/:id/disable', secReqAuth, (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can disable workers' });
  }
  if (!app.locals.workerRuntime) return res.status(500).json({ error: 'Worker runtime not available' });
  res.json(app.locals.workerRuntime.disableWorker(req.params.id));
});

app.post('/api/workers/:id/enable', secReqAuth, (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can enable workers' });
  }
  if (!app.locals.workerRuntime) return res.status(500).json({ error: 'Worker runtime not available' });
  res.json(app.locals.workerRuntime.enableWorker(req.params.id));
});

// Keychain status (Layer 3)
app.get('/api/keychain', secReqAuth, (req, res) => {
  if (!req.session?.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  res.json(keychainService.getStatus());
});

// Sandbox status
app.get('/api/sandbox', secReqAuth, (req, res) => {
  if (app.locals.workerRuntime?.sandbox) {
    const sandbox = app.locals.workerRuntime.sandbox;
    const status = {};
    for (const [agentId] of sandbox.processes) {
      status[agentId] = sandbox.getSandboxStatus(agentId);
    }
    res.json({ enabled: sandbox.enabled, workers: status });
  } else {
    res.json({ enabled: false, workers: {} });
  }
});

// Security status
app.get('/api/security', secReqAuth, async (req, res) => {
  try { res.json(await securityService.getSecuritySummary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// [MYTHOS] Security Event Stream (SSE) — real-time security events for federation hub
// Streams security-related activity log entries as Server-Sent Events.
// Federation peers and monitoring dashboards connect to this endpoint.
app.get('/api/security/events/stream', secReqAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected","instance":"' + (config.federation?.instanceId || 'standalone') + '"}\n\n');

  // Poll activity log for security events every 5 seconds
  const securityActions = new Set([
    'injection_detected', 'two_llm_consensus', 'message_quarantined',
    'quarantine_approved', 'quarantine_rejected', 'lockdown_activated',
    'lockdown_lifted', 'dangerous_command_blocked', 'command_not_in_allowlist',
    'data_leakage_blocked', 'shell_blocked', 'tool_output_injection_detected',
    'security_escalation', 'consensus_disagreement', 'keypair_generated',
  ]);

  let lastEventId = 0;
  const interval = setInterval(() => {
    db.all(
      `SELECT id, actor, action, target, details, created_at FROM activity_log
       WHERE id > ? AND action IN (${Array.from(securityActions).map(() => '?').join(',')})
       ORDER BY id ASC LIMIT 20`,
      [lastEventId, ...securityActions],
      (err, rows) => {
        if (err || !rows || rows.length === 0) return;
        for (const row of rows) {
          lastEventId = Math.max(lastEventId, row.id);
          res.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
        }
      }
    );
  }, 5000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// LOCKDOWN: Manual trigger (admin only) — requires browser session auth, NOT API key.
// API keys are readable by agents from the DB, so they cannot be trusted for security-critical actions.
app.post('/api/security/lockdown', secReqAuth, (req, res) => {
  // SECURITY: Reject API-key-only auth — agents can read admin keys from the database
  if (!req.session?.userId) {
    activityLog.append({
      actor: req.authenticatedId || 'unknown',
      action: 'lockdown_session_required',
      details: JSON.stringify({ reason: 'Attempted lockdown via API key instead of web session' }),
    });
    return res.status(403).json({ error: 'Lockdown can only be triggered from the Darkhan web UI by a human admin' });
  }
  const userType = req.session.userType || req.authenticatedType;
  if (userType !== 'human') {
    return res.status(403).json({ error: 'Only human admins can trigger lockdown' });
  }
  const reason = req.body.reason || 'Manual lockdown by admin';
  const userId = req.session.userId;
  securityService.triggerLockdown(reason, userId);
  res.json({ ok: true, lockdown: securityService.getLockdownStatus() });
});

// UNLOCK: Restore operations — requires browser session auth, NOT API key.
// This is the critical security control: agents must NEVER be able to lift lockdown,
// even if they possess a valid admin API key (which they can read from the database).
app.post('/api/security/unlock', secReqAuth, (req, res) => {
  // SECURITY: Reject API-key-only auth — agents can read admin keys from the database
  if (!req.session?.userId) {
    activityLog.append({
      actor: req.authenticatedId || 'unknown',
      action: 'unlock_session_required',
      details: JSON.stringify({ reason: 'Attempted unlock via API key instead of web session' }),
    });
    return res.status(403).json({ error: 'Lockdown can only be lifted from the Darkhan web UI by a human admin' });
  }
  const userId = req.session.userId;
  const userType = req.session.userType || 'unknown';
  if (userType !== 'human') {
    return res.status(403).json({ error: 'Only human admins can unlock the system' });
  }
  // Verify admin role from session
  const role = req.session.role;
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Only admin users can unlock the system' });
  }

  // SECURITY: If a lockdown PIN is set, require it for unlock.
  // This is the final defense — even if an agent somehow gets a session, it can't guess the PIN.
  const { pin } = req.body;

  // Check secrets.db first, fall back to main settings table for backward compatibility
  const checkPin = (pinRow) => {
    return async () => {
      if (pinRow && pinRow.value) {
        // PIN is set — require it
        if (!pin) {
          return res.status(403).json({ error: 'Lockdown PIN required to unlock', pinRequired: true });
        }
        const bcrypt = require('bcrypt');
        const pinMatch = await bcrypt.compare(pin, pinRow.value);
        if (!pinMatch) {
          activityLog.append({
            actor: userId,
            action: 'unlock_bad_pin',
            details: 'Incorrect lockdown PIN provided',
          });
          return res.status(403).json({ error: 'Incorrect lockdown PIN' });
        }
      }

      const result = securityService.unlock(userId, userType);
      if (result.success) {
        res.json({ ok: true, message: result.reason });
      } else {
        res.status(403).json({ error: result.reason });
      }
    };
  };

  // SECURITY: Lockdown PIN is stored ONLY in secrets.db — no fallback to darkhan.db settings
  // If no PIN is configured in secrets.db, fail closed (refuse to unlock)
  secretsDb.get("SELECT value FROM secret_settings WHERE key = 'lockdown_pin_hash'", [], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row || !row.value) {
      // Fail closed: no PIN configured means you cannot unlock
      return res.status(403).json({
        error: 'No lockdown PIN configured. Set a PIN via Settings before unlocking.',
        pinRequired: true,
      });
    }
    await checkPin(row)();
  });
});

// RESET BASELINE: Admin says "I made legitimate changes, update the baseline."
// Requires browser session auth + admin role (same as lockdown/unlock).
app.post('/api/security/reset-baseline', secReqAuth, async (req, res) => {
  if (!req.session?.userId) {
    return res.status(403).json({ error: 'Baseline reset requires web UI login' });
  }
  if (req.session.userType !== 'human' || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only human admins can reset the integrity baseline' });
  }

  try {
    const result = await integrityService.resetBaseline();
    activityLog.append({
      actor: req.session.userId,
      action: 'baseline_reset_requested',
      details: JSON.stringify({ files: result.files, users: result.users }),
    });
    res.json({ ok: true, baseline: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Team members (for dynamic UI)
app.get('/api/team', secReqAuth, (req, res) => {
  const members = (config.team?.members || []).map(m => ({
    id: m.id, name: m.name, type: m.type, role: m.role, channels: m.channels,
  }));
  res.json({ members, instance: config.instance });
});

// Socket.io auth — shared middleware for both / and /terminal namespaces
function socketAuthMiddleware(socket, next) {
  const apiKey = socket.handshake.auth?.apiKey || socket.handshake.query?.apiKey;
  const sessionCookie = socket.handshake.headers?.cookie;

  if (apiKey) {
    // [C-2 FIX] Socket.IO auth must use same HMAC-indexed lookup as HTTP middleware.
    // After encryption migration, api_key column contains ciphertext — plaintext lookup fails.
    const secretsCrypto = app.locals.secretsCrypto;
    const resolveSocketUser = (userId) => {
      db.get('SELECT id, username, role FROM users WHERE id = ?', [userId], (err2, user) => {
        if (err2 || !user) return next(new Error('Invalid API key — user not found'));
        socket.user = user;
        return next();
      });
    };
    if (secretsCrypto) {
      const hmac = secretsCrypto.hmac(apiKey);
      secretsDb.get('SELECT user_id FROM credentials WHERE api_key_hmac = ?', [hmac], (err, cred) => {
        if (err || !cred) {
          // Fall back to plaintext for legacy unencrypted keys
          secretsDb.get('SELECT user_id FROM credentials WHERE api_key = ?', [apiKey], (err2, cred2) => {
            if (err2 || !cred2) return next(new Error('Invalid API key'));
            resolveSocketUser(cred2.user_id);
          });
          return;
        }
        resolveSocketUser(cred.user_id);
      });
    } else {
      secretsDb.get('SELECT user_id FROM credentials WHERE api_key = ?', [apiKey], (err, cred) => {
        if (err || !cred) return next(new Error('Invalid API key'));
        resolveSocketUser(cred.user_id);
      });
    }
  } else if (sessionCookie) {
    // Parse session ID from the connect.sid cookie
    const cookieParser = require('cookie');
    const signature = require('cookie-signature');
    const cookies = cookieParser.parse(sessionCookie);
    const signedSid = cookies['connect.sid'];
    if (!signedSid) {
      return next(new Error('Authentication required — no session cookie'));
    }
    // Unsign the cookie value (strip 's:' prefix if present)
    const raw = signedSid.startsWith('s:') ? signedSid.slice(2) : signedSid;
    const sid = signature.unsign(raw, process.env.SESSION_SECRET);
    if (sid === false) {
      return next(new Error('Authentication required — invalid session signature'));
    }
    // Look up the session in the SQLite session store
    const sessionsDbPath = path.join(__dirname, 'db', 'sessions.db');
    const sessDb = new sqlite3.Database(sessionsDbPath);
    sessDb.get('SELECT sess FROM sessions WHERE sid = ?', [sid], (err, row) => {
      sessDb.close();
      if (err || !row) {
        return next(new Error('Authentication required — session not found or expired'));
      }
      try {
        const sessData = JSON.parse(row.sess);
        if (!sessData.userId) {
          return next(new Error('Authentication required — session has no user'));
        }
        socket.user = {
          id: sessData.userId,
          username: sessData.username || sessData.userId,
          role: sessData.role || 'authenticated',
          type: sessData.userType || 'human',
        };
        return next();
      } catch (parseErr) {
        return next(new Error('Authentication required — corrupt session data'));
      }
    });
    return; // async — next() called in callback
  } else {
    return next(new Error('Authentication required'));
  }
}

io.use(socketAuthMiddleware);

// Instance Identity — Ed25519 keypair for message signing and federation trust
const instanceIdentity = new InstanceIdentity({ db, secretsDb, config, activityLog });
instanceIdentity.initialize().then(() => {
  console.log(`[Darkhan] Instance identity ready (fingerprint: ${instanceIdentity.getFingerprint()})`);
}).catch(err => {
  console.error('[Darkhan] Instance identity failed:', err.message);
});
app.locals.instanceIdentity = instanceIdentity;

// Review Gate — optional output verification before posting
const { ReviewGate } = require('./services/review-gate');
const reviewGate = new ReviewGate({ config });
app.locals.reviewGate = reviewGate;

// Unified Claude Session — one Claude process, two interfaces (terminal + chat)
const unifiedClaude = new UnifiedClaudeSession({ db, io, config, activityLog });
app.locals.unifiedClaude = unifiedClaude;

// Terminal relay — Claude Code + shell sessions inside the Darkhan UI
const terminalRelay = new TerminalRelay({ io, db, config, activityLog, unifiedClaude });
io.of('/terminal').use(socketAuthMiddleware);
app.locals.terminalRelay = terminalRelay;

io.on('connection', (socket) => {
  console.log('[Darkhan] Client connected:', socket.id);
  // [H-3 FIX] Validate channel authorization before joining
  socket.on('join_channel', (channelId) => {
    // Public channels anyone can join (for web UI)
    const publicChannels = (config.channels || []).map(c => c.id);
    if (publicChannels.includes(channelId)) {
      socket.join(channelId);
    } else {
      console.warn(`[Darkhan] Rejected channel join: ${channelId} (not in config)`);
    }
  });
  socket.on('leave_channel', (channelId) => {
    socket.leave(channelId);
  });
  socket.on('disconnect', () => { console.log('[Darkhan] Client disconnected:', socket.id); });
});

// Integrity API endpoint (before SPA fallback!)
app.get('/api/security/integrity', secReqAuth, async (req, res) => {
  try {
    const result = await integrityService.verify();
    res.json({ ...result, baseline: integrityService.getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SPA fallback — must be LAST
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Start — bind host is configurable via BIND_HOST env var (default: localhost only)
server.listen(PORT, BIND_HOST, () => {
  const brandName = config.instance?.brandName || 'Darkhan';
  console.log(`[Darkhan] ${brandName} Command Center running on ${BIND_HOST}:${PORT}${BIND_HOST === '127.0.0.1' ? ' (localhost only)' : ' (network accessible)'}`);

  // --- VPS Hardening: Startup safety check ---
  const isExternal = BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost' && BIND_HOST !== '::1';
  const hasTLS = config.tls?.enabled || process.env.DARKHAN_HTTPS === 'true';
  const allowExternal = process.env.DARKHAN_ALLOW_EXTERNAL === 'true';

  if (isExternal && !hasTLS && !allowExternal) {
    console.warn('\n' + '='.repeat(72));
    console.warn('  ⚠  WARNING: DARKHAN IS BINDING TO AN EXTERNAL INTERFACE');
    console.warn('='.repeat(72));
    console.warn(`  Bind address: ${BIND_HOST}:${PORT}`);
    console.warn('  TLS: NOT DETECTED');
    console.warn('');
    console.warn('  Without TLS, passwords, API keys, session cookies, and terminal');
    console.warn('  sessions are transmitted in CLEARTEXT over the network.');
    console.warn('');
    console.warn('  To fix this, choose one:');
    console.warn('    1. Use a reverse proxy (Caddy auto-HTTPS is easiest):');
    console.warn('       Set DARKHAN_TRUST_PROXY=true and DARKHAN_HTTPS=true');
    console.warn('    2. Use a VPN overlay (Tailscale/WireGuard):');
    console.warn('       Bind to the VPN IP instead of 0.0.0.0');
    console.warn('    3. Acknowledge the risk:');
    console.warn('       Set DARKHAN_ALLOW_EXTERNAL=true');
    console.warn('='.repeat(72) + '\n');
  } else if (isExternal && (hasTLS || allowExternal)) {
    console.log(`[Darkhan] External binding acknowledged${hasTLS ? ' (TLS enabled)' : ' (DARKHAN_ALLOW_EXTERNAL=true)'}`);
  }

  // Health monitor
  const { startMonitor } = require('./services/monitor');
  startMonitor(db, io);

  // Check local LLM model capability — warn if below recommended minimum
  const configuredModel = process.env.OLLAMA_MODEL || config.llm?.triage?.model || 'unknown';
  const modelSizeMatch = configuredModel.match(/(\d+)b/i);
  const modelSizeB = modelSizeMatch ? parseInt(modelSizeMatch[1]) : 0;
  if (modelSizeB > 0 && modelSizeB < 14) {
    console.warn(`[Darkhan] WARNING: Local LLM "${configuredModel}" is below the recommended minimum (14B).`);
    console.warn(`[Darkhan] Triage, injection detection, and consensus verification may be unreliable.`);
    console.warn(`[Darkhan] Recommended: qwen2.5:14b or any 14B+ model. Run: ollama pull qwen2.5:14b`);
  } else if (modelSizeB >= 14) {
    console.log(`[Darkhan] Local LLM: ${configuredModel} (meets minimum capability)`);
  }

  // TRANSCRIPT: Capture channel conversations to docs/transcripts/ every 30 min.
  // Runs OUTSIDE the integrity-gated block — transcript writes to docs/ never
  // trigger lockdown (integrity only monitors server/ code and workers/).
  // Each day gets its own file: Transcript_YYYY-MM-DD.md
  const TRANSCRIPT_DIR = path.join(__dirname, '..', 'docs', 'transcripts');
  const TRANSCRIPT_CHANNELS = ['chan_command', 'chan_claude', 'chan_alerts'];

  async function writeTranscript() {
    const now = new Date();
    const dateStr = now.toISOString().substring(0, 10);
    const transcriptFile = path.join(TRANSCRIPT_DIR, `Transcript_${dateStr}.md`);
    const startOfDay = dateStr + ' 00:00:00';

    const allMessages = [];
    for (const ch of TRANSCRIPT_CHANNELS) {
      try {
        const msgs = await new Promise((resolve, reject) => {
          db.all(
            'SELECT from_user, body, created_at, channel_id FROM messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 2000',
            [ch, startOfDay],
            (err, rows) => err ? reject(err) : resolve(rows || [])
          );
        });
        allMessages.push(...msgs);
      } catch (e) { /* skip channel */ }
    }

    if (allMessages.length === 0) return;
    allMessages.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

    const lines = [
      `# Darkhan Transcript — ${dateStr}`,
      ``,
      `> Auto-generated every 30 minutes. Code blocks stripped for readability.`,
      `> Channels: ${TRANSCRIPT_CHANNELS.map(c => c.replace('chan_', '#')).join(', ')}`,
      ``,
      `---`,
      ``,
    ];

    let currentChannel = '';
    for (const msg of allMessages) {
      const ch = (msg.channel_id || '').replace('chan_', '#');
      if (ch !== currentChannel) {
        if (currentChannel) lines.push('');
        lines.push(`### ${ch}`);
        lines.push('');
        currentChannel = ch;
      }

      const time = (msg.created_at || '').substring(11, 19) || '??:??:??';
      const from = msg.from_user || 'unknown';
      let body = (msg.body || '').replace(/```[\s\S]*?```/g, '[code block removed]');
      if (body === '...thinking' || body.startsWith('...working')) continue;
      if (body.length > 2000) body = body.substring(0, 2000) + '... [truncated]';

      lines.push(`**[${time}] ${from}:** ${body}`);
      lines.push('');
    }

    try {
      if (!fs.existsSync(TRANSCRIPT_DIR)) fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
      fs.writeFileSync(transcriptFile, lines.join('\n'));
      console.log(`[Transcript] Updated ${transcriptFile} (${allMessages.length} messages)`);
    } catch (e) {
      console.error(`[Transcript] Write failed: ${e.message}`);
    }
  }

  // Track last message count to skip writes when nothing new
  let lastTranscriptMessageCount = 0;

  async function writeTranscriptIfNew() {
    try {
      const dateStr = new Date().toISOString().substring(0, 10);
      const startOfDay = dateStr + ' 00:00:00';
      const count = await new Promise((resolve, reject) => {
        db.get(
          'SELECT COUNT(*) as c FROM messages WHERE channel_id IN (?,?,?) AND created_at > ?',
          ['chan_command', 'chan_claude', 'chan_alerts', startOfDay],
          (err, row) => err ? reject(err) : resolve(row?.c || 0)
        );
      });

      if (count === lastTranscriptMessageCount && count > 0) {
        // No new messages since last write — skip
        return;
      }

      lastTranscriptMessageCount = count;
      await writeTranscript();
    } catch (e) {
      console.error('[Transcript] Check failed:', e.message);
    }
  }

  // Run on startup (after 5s delay for DB readiness) and every 30 minutes
  setTimeout(() => writeTranscriptIfNew(), 5000);
  setInterval(() => writeTranscriptIfNew(), 30 * 60 * 1000);

  // Delay startup sequence to ensure DB schema is fully applied
  setTimeout(async () => {
    // RATE LIMITER: Restore today's usage from cost_tracking so restarts don't reset budgets
    try {
      await rateLimiter.init(db);
      console.log('[Darkhan] Rate limiter usage restored from DB');
    } catch (e) {
      console.warn('[Darkhan] Rate limiter init failed (non-fatal):', e.message);
    }

    // [HARDENING-4] Deploy mode: human-authorized baseline reset before startup.
    // Usage: node server.js --deploy (requires TTY + lockdown PIN)
    if (process.argv.includes('--deploy')) {
      const deployOk = await (async () => {
        // Security: refuse to run from agent terminals
        if (process.env.CLAUDE_CODE || process.env.DARKHAN_RELAY_SESSION || process.env.DARKHAN_PTY_SESSION) {
          console.error('[Deploy] REFUSED: Cannot run deploy mode from an agent terminal session.');
          return false;
        }
        if (!process.stdin.isTTY) {
          console.error('[Deploy] REFUSED: Deploy mode requires an interactive terminal (TTY).');
          return false;
        }
        const readline = require('readline');
        const bcrypt = require('bcrypt');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const askPin = () => new Promise((resolve) => {
          process.stdout.write('[Deploy] Enter lockdown PIN to authorize baseline reset: ');
          // Note: PIN is visible in terminal — break-glass.js has hidden echo but
          // for simplicity here we accept visible input. Users can use break-glass for hidden.
          rl.question('', (answer) => { resolve(answer.trim()); });
        });

        // Check if PIN is configured
        const pinRow = await new Promise((resolve) => {
          secretsDb.get(`SELECT value FROM secret_settings WHERE key = 'lockdown_pin_hash'`, [], (err, row) => {
            resolve(err ? null : row);
          });
        });

        if (!pinRow || !pinRow.value) {
          console.warn('[Deploy] No lockdown PIN configured. Proceeding with baseline reset.');
          console.warn('[Deploy] Set a lockdown PIN via the web UI for stronger security.');
          rl.close();
          await integrityService.resetBaseline();
          activityLog.append({ actor: 'human_admin', action: 'deploy_mode_no_pin', details: '{}' });
          return true;
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
          const pin = await askPin();
          const match = await bcrypt.compare(pin, pinRow.value);
          if (match) {
            console.log('[Deploy] PIN verified. Resetting integrity baseline...');
            rl.close();
            await integrityService.resetBaseline();
            activityLog.append({
              actor: 'human_admin',
              action: 'deploy_mode_baseline_reset',
              details: JSON.stringify({ authorized: true }),
            });
            console.log('[Deploy] Baseline reset complete. Continuing startup...');
            return true;
          }
          console.error(`[Deploy] Incorrect PIN (attempt ${attempt}/3).`);
          activityLog.append({
            actor: 'human_admin',
            action: 'deploy_mode_failed_auth',
            details: JSON.stringify({ attempt }),
          });
        }
        rl.close();
        console.error('[Deploy] 3 failed attempts. Aborting.');
        return false;
      })();

      if (!deployOk) {
        process.exit(1);
      }
      // Skip normal baseline establishment — deploy mode already reset it
    } else {
    // INTEGRITY: Establish baseline before loading workers
    try {
      await integrityService.establishBaseline();
      console.log('[Darkhan] Integrity baseline established');
    } catch (e) {
      console.error('[Darkhan] Integrity baseline failed:', e.message);
    }
    } // end deploy mode else

    // INTEGRITY: Verify BEFORE loading workers (P1-R7)
    // If any violations found, don't load workers (lockdown will be triggered by verify)
    try {
      const preCheck = await integrityService.verify();
      if (!preCheck.clean) {
        console.error(`[Darkhan] Integrity violations detected — workers NOT loaded`);
        activityLog.append({
          actor: 'system', action: 'workers_blocked',
          details: JSON.stringify({ violations: preCheck.violations.length }),
        });
        // Workers stay unloaded — lockdown is already triggered by verify()
        return;
      }
    } catch (e) {
      console.warn('[Darkhan] Pre-load integrity check failed:', e.message);
    }

    // Start worker runtime (only if integrity is clean)
    const workerRuntime = new WorkerRuntime({
      llmService, db, io, config, activityLog, costTracker, securityService
    });
    app.locals.workerRuntime = workerRuntime;

    try {
      await workerRuntime.loadAll();
      console.log(`[Darkhan] Worker runtime: ${workerRuntime.workers.size} worker(s) loaded`);
      activityLog.append({
        actor: 'system', action: 'server_started', target: `${BIND_HOST}:${PORT}`,
        details: JSON.stringify({ brandName, workers: workerRuntime.workers.size, bindHost: BIND_HOST }),
      });
    } catch (err) {
      console.error('[Darkhan] Worker runtime error:', err.message);
    }

    // MAINTENANCE: Startup cleanup + daily schedule
    const maintenance = new MaintenanceService({ db, activityLog, workerRuntime });
    app.locals.maintenance = maintenance;
    try {
      await maintenance.startup();
      maintenance.startSchedule();
    } catch (err) {
      console.error('[Darkhan] Maintenance startup error:', err.message);
    }

    // INTEGRITY: Periodic verification every 5 minutes
    setInterval(async () => {
      try {
        const result = await integrityService.verify();
        integrityService._lastCheckResult = {
          clean: result.clean,
          violations: result.violations.length,
          checkedAt: new Date().toISOString(),
        };
        if (!result.clean) {
          console.warn(`[Integrity] ${result.violations.length} violation(s) detected`);
        }
      } catch (e) {
        console.error('[Integrity] Verification error:', e.message);
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    // INTEGRITY: Check network binding
    const networkViolations = integrityService.checkNetworkBinding();
    if (networkViolations.length > 0) {
      console.warn('[Integrity] Network binding violations:', networkViolations);
    }
  }, 2000);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`[Darkhan] ${signal} received, shutting down...`);
  if (app.locals.terminalRelay) await app.locals.terminalRelay.shutdown();
  if (app.locals.unifiedClaude) await app.locals.unifiedClaude.shutdown();
  if (app.locals.workerRuntime) await app.locals.workerRuntime.shutdown();
  if (app.locals.maintenance) app.locals.maintenance.shutdown();
  server.close();
  db.close();
  secretsDb.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
