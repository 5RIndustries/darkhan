require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session');
const cors = require('cors');

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
      rejectUnauthorized: false,    // Don't reject at TLS level — check per-route instead
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

const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || `http${config.tls?.enabled ? 's' : ''}://localhost:${config.instance?.port || 3001}`,
    credentials: true
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
app.use(cors({
  origin: process.env.CORS_ORIGIN || `http://localhost:${PORT}`,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Persistent session store — survives server restarts
const SQLiteStore = require('connect-sqlite3')(session);
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
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
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

// Make services available to routes
app.locals.db = db;
app.locals.secretsDb = secretsDb;  // Credential-isolated DB — NOT passed to workers
app.locals.io = io;
app.locals.config = config;
app.locals.activityLog = activityLog;
app.locals.costTracker = costTracker;
app.locals.rateLimiter = rateLimiter;
app.locals.llmService = llmService;
app.locals.securityService = securityService;
app.locals.integrityService = integrityService;
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
const claudeRoutes = require('./routes/claude');
const approvalsRoutes = require('./routes/approvals');

// Auth middleware for inline route protection
const { requireAuth: secReqAuth } = require('./middleware/auth');

app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/approvals', approvalsRoutes);

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

// Chain head — lightweight endpoint for cross-instance verification (Mokume)
app.get('/api/activity/chain-head', secReqAuth, async (req, res) => {
  try { res.json(await activityLog.getChainHead()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Chain statistics — dashboard-friendly summary
app.get('/api/activity/stats', secReqAuth, async (req, res) => {
  try { res.json(await activityLog.getChainStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Defense spacers — list CRISPR-style entries for Mokume propagation
app.get('/api/activity/spacers', secReqAuth, async (req, res) => {
  try {
    const { category, since, limit } = req.query;
    const spacers = await activityLog.getSpacers({
      category, since, limit: parseInt(limit) || 100,
    });
    res.json({ spacers, instanceId: config.federation?.instanceId || 'standalone' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ingest remote spacer from federated peer (Mokume endpoint)
app.post('/api/activity/spacers/ingest', secReqAuth, (req, res) => {
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

// Worker runtime status
app.get('/api/workers', secReqAuth, (req, res) => {
  if (app.locals.workerRuntime) {
    res.json({ workers: app.locals.workerRuntime.getStatus() });
  } else {
    res.json({ workers: [], message: 'Worker runtime not initialized' });
  }
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

// Socket.io auth
io.use((socket, next) => {
  const apiKey = socket.handshake.auth?.apiKey || socket.handshake.query?.apiKey;
  const sessionCookie = socket.handshake.headers?.cookie;

  if (apiKey) {
    // SECURITY: API keys are stored ONLY in secrets.db — no fallback to darkhan.db
    secretsDb.get('SELECT user_id FROM credentials WHERE api_key = ?', [apiKey], (err, cred) => {
      if (err || !cred) {
        return next(new Error('Invalid API key'));
      }
      db.get('SELECT id, username, role FROM users WHERE id = ?', [cred.user_id], (err2, user) => {
        if (err2 || !user) return next(new Error('Invalid API key — user not found'));
        socket.user = user;
        return next();
      });
    });
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
});

io.on('connection', (socket) => {
  console.log('[Darkhan] Client connected:', socket.id);
  socket.on('join_channel', (channelId) => { socket.join(channelId); });
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

  // Health monitor
  const { startMonitor } = require('./services/monitor');
  startMonitor(db, io);

  // Delay startup sequence to ensure DB schema is fully applied
  setTimeout(async () => {
    // RATE LIMITER: Restore today's usage from cost_tracking so restarts don't reset budgets
    try {
      await rateLimiter.init(db);
      console.log('[Darkhan] Rate limiter usage restored from DB');
    } catch (e) {
      console.warn('[Darkhan] Rate limiter init failed (non-fatal):', e.message);
    }

    // INTEGRITY: Establish baseline before loading workers
    try {
      await integrityService.establishBaseline();
      console.log('[Darkhan] Integrity baseline established');
    } catch (e) {
      console.error('[Darkhan] Integrity baseline failed:', e.message);
    }

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
  if (app.locals.workerRuntime) await app.locals.workerRuntime.shutdown();
  server.close();
  db.close();
  secretsDb.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
