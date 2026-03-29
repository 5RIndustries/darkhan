/**
 * Darkhan — Authentication Middleware
 * Protects routes via session auth (web UI) or API key (agent access).
 *
 * SECURITY INVARIANT: An agent can NEVER post as a human, and a human can
 * NEVER post as a different human. Identity is locked to the authenticated
 * session or API key. No override, no impersonation, no exceptions.
 */

// Middleware: require session OR valid API key
function requireAuth(req, res, next) {
  // 1. Check session (web UI users — humans)
  if (req.session && req.session.userId) {
    req.authenticatedId = req.session.userId;
    req.authenticatedType = req.session.userType || 'human';
    return next();
  }

  // 2. Check API key header (agent service accounts)
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const db = req.app.locals.db;
    const secretsDb = req.app.locals.secretsDb;

    // Look up API key in secrets.db (credential-isolated), then resolve user from main DB
    const resolveUser = (userId) => {
      db.get('SELECT id, username, role, type FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
          console.error('Auth middleware DB error:', err.message);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (!user) {
          return res.status(401).json({ error: 'Invalid API key — user not found' });
        }
        req.user = user;
        req.authenticatedId = user.id;
        req.authenticatedType = user.type || 'agent';
        return next();
      });
    };

    // SECURITY: API keys are stored ONLY in secrets.db — no fallback to darkhan.db
    if (!secretsDb) {
      console.error('Auth middleware: secrets.db not available — cannot authenticate API keys');
      return res.status(500).json({ error: 'Credential store unavailable' });
    }

    secretsDb.get('SELECT user_id FROM credentials WHERE api_key = ?', [apiKey], (err, cred) => {
      if (err) {
        console.error('Auth middleware secrets.db error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!cred) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      resolveUser(cred.user_id);
    });
    return;
  }

  // 3. Neither session nor API key
  return res.status(401).json({ error: 'Authentication required' });
}

// Middleware: require admin role
function requireAdmin(req, res, next) {
  const role = (req.session && req.session.role) || (req.user && req.user.role);
  if (role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

/**
 * Get the ENFORCED user id for the current request.
 * This is the authenticated identity — it CANNOT be overridden by request body.
 *
 * SECURITY: This function ensures identity integrity.
 * - If authenticated via session (human): returns the session user id
 * - If authenticated via API key (agent): returns the API key's user id
 * - An agent API key can NEVER return a human user id
 * - A human session can NEVER return a different human's id
 */
function getCurrentUserId(req) {
  // Always return the authenticated identity, never a request-supplied override
  if (req.authenticatedId) return req.authenticatedId;
  if (req.session && req.session.userId) return req.session.userId;
  if (req.user && req.user.id) return req.user.id;
  return null;
}

/**
 * Validate that a from_user matches the authenticated identity.
 * Used by message routes to prevent impersonation.
 *
 * Returns { valid: boolean, reason?: string, enforcedId: string }
 */
function validateIdentity(req, requestedFromUser) {
  const authenticatedId = getCurrentUserId(req);
  const authenticatedType = req.authenticatedType || 'unknown';

  if (!authenticatedId) {
    return { valid: false, reason: 'No authenticated identity', enforcedId: null };
  }

  // RULE 1: Agents cannot post as humans
  if (authenticatedType === 'agent' && requestedFromUser && requestedFromUser.startsWith('user_')) {
    const activityLog = req.app.locals.activityLog;
    if (activityLog) {
      activityLog.append({
        actor: 'darkhan_security',
        action: 'impersonation_blocked',
        target: authenticatedId,
        details: JSON.stringify({
          attempted: requestedFromUser,
          authenticatedAs: authenticatedId,
          type: authenticatedType,
        }),
      });
    }
    return {
      valid: false,
      reason: `Agent ${authenticatedId} cannot post as human ${requestedFromUser}`,
      enforcedId: authenticatedId,
    };
  }

  // RULE 2: Humans cannot post as different humans
  if (authenticatedType === 'human' && requestedFromUser &&
      requestedFromUser.startsWith('user_') && requestedFromUser !== authenticatedId) {
    return {
      valid: false,
      reason: `Human ${authenticatedId} cannot post as ${requestedFromUser}`,
      enforcedId: authenticatedId,
    };
  }

  // RULE 3: Humans cannot post as agents
  if (authenticatedType === 'human' && requestedFromUser &&
      requestedFromUser.startsWith('agent_')) {
    return {
      valid: false,
      reason: `Human ${authenticatedId} cannot post as agent ${requestedFromUser}`,
      enforcedId: authenticatedId,
    };
  }

  // RULE 4: Agents can only post as themselves
  if (authenticatedType === 'agent' && requestedFromUser &&
      requestedFromUser !== authenticatedId) {
    return {
      valid: false,
      reason: `Agent ${authenticatedId} cannot post as ${requestedFromUser}`,
      enforcedId: authenticatedId,
    };
  }

  return { valid: true, enforcedId: authenticatedId };
}

module.exports = { requireAuth, requireAdmin, getCurrentUserId, validateIdentity };
