/**
 * Darkhan — Vault Routes (Knowledge Base)
 *
 * File system access for the team's knowledge base.
 * Provides: directory listing, file read/write/create/delete, full-text search.
 *
 * The vault is a directory of markdown files on the server's file system.
 * Path is configured in darkhan.config.json under vault.path.
 * Agents and humans read/write the same files — Darkhan provides the UI.
 *
 * GET    /api/vault/tree          — recursive directory listing
 * GET    /api/vault/file?path=    — read file contents
 * PUT    /api/vault/file?path=    — update existing file
 * POST   /api/vault/file?path=    — create new file
 * DELETE /api/vault/file?path=    — delete file
 * GET    /api/vault/search?q=     — full-text search across all files
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

/**
 * Resolve the vault root path from config.
 */
function getVaultPath(req) {
  const config = req.app.locals.config;
  const raw = config?.vault?.path || '~/darkhan-vault';
  return raw.replace('~', process.env.HOME);
}

/**
 * Ensure a requested path is inside the vault (prevent directory traversal).
 */
function safePath(vaultRoot, requestedPath) {
  const resolved = path.resolve(vaultRoot, requestedPath);
  if (!resolved.startsWith(vaultRoot)) {
    return null; // Traversal attempt
  }
  return resolved;
}

/**
 * GET /api/vault/tree — recursive directory listing
 * Query params:
 *   dir (optional) — subdirectory to list (default: vault root)
 *   depth (optional) — max recursion depth (default: 3)
 */
router.get('/tree', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const subDir = req.query.dir || '';
  const maxDepth = Math.min(parseInt(req.query.depth) || 3, 10);

  const targetDir = safePath(vaultRoot, subDir);
  if (!targetDir) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(targetDir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  try {
    const tree = buildTree(targetDir, vaultRoot, 0, maxDepth);
    res.json({ root: subDir || '/', tree });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildTree(dirPath, vaultRoot, depth, maxDepth) {
  if (depth >= maxDepth) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.obsidian')
    .sort((a, b) => {
      // Directories first, then files, alphabetical within each
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(entry => {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(vaultRoot, fullPath);

    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children: buildTree(fullPath, vaultRoot, depth + 1, maxDepth),
      };
    } else {
      const stats = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: stats.size,
        modified: stats.mtime.toISOString(),
        ext: path.extname(entry.name).toLowerCase(),
      };
    }
  });
}

/**
 * GET /api/vault/file?path= — read file contents
 */
router.get('/file', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: 'path parameter required' });
  }

  const fullPath = safePath(vaultRoot, filePath);
  if (!fullPath) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const stats = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({
      path: filePath,
      content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      ext: path.extname(filePath).toLowerCase(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/vault/file?path= — update existing file
 * Body: { content: "file contents" }
 */
router.put('/file', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const filePath = req.query.path;
  const { content } = req.body;

  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'path parameter and content body required' });
  }

  const fullPath = safePath(vaultRoot, filePath);
  if (!fullPath) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found — use POST to create' });
  }

  try {
    fs.writeFileSync(fullPath, content, 'utf8');

    // Activity log
    const activityLog = req.app.locals.activityLog;
    if (activityLog) {
      const userId = req.session?.userId || req.user?.id || 'unknown';
      activityLog.append({
        actor: userId,
        action: 'file_updated',
        target: filePath,
        details: JSON.stringify({ size: content.length }),
      });
    }

    res.json({ ok: true, path: filePath, size: content.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/vault/file?path= — create new file
 * Body: { content: "file contents" }
 */
router.post('/file', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const filePath = req.query.path;
  const { content = '' } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'path parameter required' });
  }

  const fullPath = safePath(vaultRoot, filePath);
  if (!fullPath) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (fs.existsSync(fullPath)) {
    return res.status(409).json({ error: 'File already exists — use PUT to update' });
  }

  try {
    // Create parent directories if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    const activityLog = req.app.locals.activityLog;
    if (activityLog) {
      const userId = req.session?.userId || req.user?.id || 'unknown';
      activityLog.append({
        actor: userId,
        action: 'file_created',
        target: filePath,
        details: JSON.stringify({ size: content.length }),
      });
    }

    res.status(201).json({ ok: true, path: filePath, size: content.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/vault/file?path= — delete a file
 */
router.delete('/file', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ error: 'path parameter required' });
  }

  const fullPath = safePath(vaultRoot, filePath);
  if (!fullPath) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Safety: don't delete directories through this endpoint
  if (fs.statSync(fullPath).isDirectory()) {
    return res.status(400).json({ error: 'Cannot delete directories through this endpoint' });
  }

  try {
    fs.unlinkSync(fullPath);

    const activityLog = req.app.locals.activityLog;
    if (activityLog) {
      const userId = req.session?.userId || req.user?.id || 'unknown';
      activityLog.append({
        actor: userId,
        action: 'file_deleted',
        target: filePath,
      });
    }

    res.json({ ok: true, path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/vault/search?q= — full-text search across vault files
 * Query params:
 *   q — search query (required)
 *   dir — subdirectory to search (optional, default: vault root)
 *   ext — file extension filter (optional, default: .md)
 *   limit — max results (optional, default: 50)
 */
router.get('/search', (req, res) => {
  const vaultRoot = getVaultPath(req);
  const query = req.query.q;
  const subDir = req.query.dir || '';
  const ext = req.query.ext || '.md';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  if (!query) {
    return res.status(400).json({ error: 'q parameter required' });
  }

  const searchDir = safePath(vaultRoot, subDir);
  if (!searchDir) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  try {
    const results = [];
    searchFiles(searchDir, vaultRoot, query.toLowerCase(), ext, results, limit);
    res.json({ query, results, count: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function searchFiles(dirPath, vaultRoot, query, ext, results, limit) {
  if (results.length >= limit) return;
  if (!fs.existsSync(dirPath)) return;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      searchFiles(fullPath, vaultRoot, query, ext, results, limit);
    } else if (!ext || entry.name.endsWith(ext)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lowerContent = content.toLowerCase();
        const idx = lowerContent.indexOf(query);

        if (idx !== -1) {
          // Extract context around the match
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + query.length + 60);
          const context = content.substring(start, end).replace(/\n/g, ' ');

          results.push({
            path: path.relative(vaultRoot, fullPath),
            name: entry.name,
            context: (start > 0 ? '...' : '') + context + (end < content.length ? '...' : ''),
            matchIndex: idx,
            modified: fs.statSync(fullPath).mtime.toISOString(),
          });
        }
      } catch (e) {
        // Skip files that can't be read
      }
    }
  }
}

module.exports = router;
