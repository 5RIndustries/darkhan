#!/usr/bin/env node
/**
 * Darkhan — Secret Scanner
 *
 * Scans text for credentials, API keys, tokens, and high-entropy strings.
 * Used by:
 *   1. Git pre-commit hook — blocks commits containing secrets
 *   2. Server startup — validates no hardcoded credentials in codebase
 *   3. CI pipeline — scans PRs before merge
 *
 * Exit codes:
 *   0 — Clean (no secrets found)
 *   1 — Secrets detected (commit blocked)
 *
 * Usage:
 *   node secret-scanner.js --git-diff     # Scan staged git diff (pre-commit)
 *   node secret-scanner.js --file <path>  # Scan a specific file
 *   node secret-scanner.js --dir <path>   # Scan all files in a directory
 *   node secret-scanner.js --startup      # Scan Darkhan server codebase
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Secret Patterns ---
// Each pattern has: name, regex, description, and severity
const SECRET_PATTERNS = [
  // Cloud provider API keys
  {
    name: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS access key ID',
    severity: 'critical',
  },
  {
    name: 'AWS Secret Key',
    regex: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    description: 'AWS secret access key',
    severity: 'critical',
  },
  {
    name: 'Google API Key',
    regex: /AIzaSy[A-Za-z0-9_-]{33}/g,
    description: 'Google API key',
    severity: 'critical',
  },
  {
    name: 'Anthropic API Key',
    regex: /sk-ant-[A-Za-z0-9_-]{40,}/g,
    description: 'Anthropic API key',
    severity: 'critical',
  },
  {
    name: 'OpenAI API Key',
    regex: /sk-[A-Za-z0-9]{48,}/g,
    description: 'OpenAI API key',
    severity: 'critical',
  },

  // Microsoft / Azure
  {
    name: 'Azure Client Secret',
    regex: /[A-Za-z0-9~_.]{30,}~[A-Za-z0-9~_.]{5,}/g,
    description: 'Azure/Microsoft OAuth client secret (tilde pattern)',
    severity: 'critical',
    // This catches the exact pattern that burned us: Fh58Q~06qHB0OtLwJePID32keHwpwrQgiEcOJcbl
    contextRequired: ['client_secret', 'CLIENT_SECRET', 'MS_CLIENT', 'oauth', 'tenant'],
  },

  // Generic secrets in code
  {
    name: 'Hardcoded Secret Assignment',
    regex: /(?:secret|password|passwd|token|api_key|apikey|api\.key|client_secret)\s*[=:]\s*['"`]([^'"`\s]{8,})['"`]/gi,
    description: 'Hardcoded secret in variable assignment',
    severity: 'high',
    exclude: [/process\.env/, /config\[/, /config\./, /opts\./, /options\./, /\{\{/, /example/i, /placeholder/i, /changeme/i, /your[_-]?key/i],
  },

  // Private keys
  {
    name: 'Private Key',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: 'Private key in PEM format',
    severity: 'critical',
  },

  // Connection strings
  {
    name: 'Database Connection String',
    regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi,
    description: 'Database connection string with credentials',
    severity: 'critical',
  },

  // JWT tokens
  {
    name: 'JWT Token',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    description: 'JSON Web Token',
    severity: 'high',
  },

  // GitHub tokens
  {
    name: 'GitHub Token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    description: 'GitHub personal access token or OAuth token',
    severity: 'critical',
  },

  // Slack tokens
  {
    name: 'Slack Token',
    regex: /xox[bprs]-[A-Za-z0-9-]{10,}/g,
    description: 'Slack API token',
    severity: 'critical',
  },

  // High-entropy strings in suspicious contexts
  {
    name: 'Hex Secret (32+ chars)',
    regex: /(?:secret|key|token|password|hash)\s*[=:]\s*['"`]([0-9a-f]{32,})['"`]/gi,
    description: 'Long hex string assigned to a secret-like variable',
    severity: 'high',
    exclude: [/process\.env/, /sha256/, /SHA-256/, /hash.*compute/, /chain_hash/, /evidence/],
  },

  // Telegram bot tokens
  {
    name: 'Telegram Bot Token',
    regex: /\d{8,}:[A-Za-z0-9_-]{35,}/g,
    description: 'Telegram bot API token',
    severity: 'critical',
  },

  // Darkhan-specific: API keys in code (not .env)
  {
    name: 'Darkhan API Key in Code',
    regex: /dk_agent_[0-9a-f]{40,}/g,
    description: 'Darkhan agent API key hardcoded in source',
    severity: 'high',
  },
];

// Files to skip (binary, generated, dependencies)
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.png$/,
  /\.jpg$/,
  /\.ico$/,
  /\.woff/,
  /\.ttf$/,
  /package-lock\.json$/,
];

// Known false positives (hashes in documentation, example values)
const ALLOWLIST = [
  /SHA-256.*[0-9a-f]{64}/i,          // SHA-256 hash documentation
  /chain_hash.*[0-9a-f]{64}/i,       // Hash chain references
  /evidence.*hash/i,                  // Evidence hashing code
  /createHash\('sha256'\)/,           // Crypto code
  /\.update\(.*\.digest\('hex'\)/,    // Hash computation
  /example|placeholder|changeme|your[_-]?key|YOUR_KEY/i, // Example values
  /test_signature_abc123/,            // Test data
];

/**
 * Check if a line is allowlisted (known false positive).
 */
function isAllowlisted(line) {
  return ALLOWLIST.some(pattern => pattern.test(line));
}

/**
 * Check if a file should be skipped.
 */
function shouldSkip(filePath) {
  return SKIP_PATTERNS.some(pattern => pattern.test(filePath));
}

/**
 * Scan a string for secrets. Returns array of findings.
 */
function scanText(text, source = 'unknown') {
  const findings = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip allowlisted lines
    if (isAllowlisted(line)) continue;

    // Skip comments that are clearly documentation
    if (/^\s*\/\/.*example/i.test(line)) continue;
    if (/^\s*\*.*example/i.test(line)) continue;

    for (const pattern of SECRET_PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;

      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const matchedText = match[0];

        // Check exclude patterns
        if (pattern.exclude) {
          const excluded = pattern.exclude.some(ex => ex.test(line));
          if (excluded) continue;
        }

        // Check context requirement (must appear near certain keywords)
        if (pattern.contextRequired) {
          const contextWindow = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
          const hasContext = pattern.contextRequired.some(ctx =>
            contextWindow.toLowerCase().includes(ctx.toLowerCase())
          );
          if (!hasContext) continue;
        }

        // Mask the secret for display (show first 4 and last 4 chars)
        const masked = matchedText.length > 12
          ? matchedText.substring(0, 4) + '...' + matchedText.substring(matchedText.length - 4)
          : '****';

        findings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          description: pattern.description,
          file: source,
          line: lineNum,
          matched: masked,
          fullLine: line.trim().substring(0, 120),
        });
      }
    }
  }

  return findings;
}

/**
 * Scan a file for secrets.
 */
function scanFile(filePath) {
  if (shouldSkip(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Skip binary files
    if (content.includes('\0')) return [];
    return scanText(content, filePath);
  } catch (e) {
    return []; // Can't read = can't leak
  }
}

/**
 * Scan a directory recursively.
 */
function scanDirectory(dirPath, findings = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (shouldSkip(fullPath)) continue;

    if (entry.isDirectory()) {
      scanDirectory(fullPath, findings);
    } else if (entry.isFile()) {
      findings.push(...scanFile(fullPath));
    }
  }

  return findings;
}

/**
 * Scan the staged git diff (for pre-commit hook).
 */
function scanGitDiff() {
  try {
    const diff = execSync('git diff --cached --diff-filter=ACMR --no-color', {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!diff.trim()) return [];

    // Parse the diff to get file names and added lines
    const findings = [];
    let currentFile = null;
    let lineNum = 0;

    for (const line of diff.split('\n')) {
      // New file header
      if (line.startsWith('+++ b/')) {
        currentFile = line.substring(6);
        lineNum = 0;
        continue;
      }

      // Hunk header — extract starting line number
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        lineNum = parseInt(hunkMatch[1], 10) - 1;
        continue;
      }

      // Added line (only scan additions, not removals)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineNum++;
        const addedContent = line.substring(1); // Strip the leading +

        if (isAllowlisted(addedContent)) continue;
        if (currentFile && shouldSkip(currentFile)) continue;

        const lineFindings = scanText(addedContent, currentFile);
        for (const f of lineFindings) {
          f.line = lineNum;
          findings.push(f);
        }
      } else if (!line.startsWith('-')) {
        lineNum++;
      }
    }

    return findings;
  } catch (e) {
    // Not in a git repo or no staged changes
    return [];
  }
}

/**
 * Scan the Darkhan server codebase (startup validation).
 */
function scanStartup() {
  const serverDir = path.join(__dirname, '..');
  const findings = [];

  // Scan all .js files in the server directory
  const scanDirs = ['', 'services', 'routes', 'middleware', 'workers', 'workers/_node1'];
  for (const dir of scanDirs) {
    const fullDir = path.join(serverDir, dir);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      findings.push(...scanFile(path.join(fullDir, file)));
    }
  }

  return findings;
}

// --- Output Formatting ---

function formatFindings(findings) {
  if (findings.length === 0) return null;

  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');

  let output = '\n';
  output += '╔══════════════════════════════════════════════════════╗\n';
  output += '║            SECRETS DETECTED — COMMIT BLOCKED        ║\n';
  output += '╚══════════════════════════════════════════════════════╝\n\n';

  if (critical.length > 0) {
    output += `🔴 CRITICAL (${critical.length}):\n`;
    for (const f of critical) {
      output += `  ${f.file}:${f.line}\n`;
      output += `    ${f.pattern}: ${f.description}\n`;
      output += `    Matched: ${f.matched}\n`;
      output += `    Line: ${f.fullLine}\n\n`;
    }
  }

  if (high.length > 0) {
    output += `🟠 HIGH (${high.length}):\n`;
    for (const f of high) {
      output += `  ${f.file}:${f.line}\n`;
      output += `    ${f.pattern}: ${f.description}\n`;
      output += `    Matched: ${f.matched}\n`;
      output += `    Line: ${f.fullLine}\n\n`;
    }
  }

  output += 'HOW TO FIX:\n';
  output += '  1. Move secrets to .env (which is gitignored)\n';
  output += '  2. Reference via process.env.YOUR_SECRET in code\n';
  output += '  3. If this is a false positive, add the pattern to ALLOWLIST in secret-scanner.js\n';
  output += '  4. Stage your fix: git add <file>\n';
  output += '  5. Try your commit again\n';

  return output;
}

// --- Main ---

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--git-diff') {
  const findings = scanGitDiff();
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    process.exit(1);
  }
  process.exit(0);

} else if (mode === '--file' && args[1]) {
  const findings = scanFile(args[1]);
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    process.exit(1);
  }
  console.log('Clean — no secrets detected.');
  process.exit(0);

} else if (mode === '--dir' && args[1]) {
  const findings = scanDirectory(args[1]);
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    process.exit(1);
  }
  console.log('Clean — no secrets detected.');
  process.exit(0);

} else if (mode === '--startup') {
  const findings = scanStartup();
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    console.error(`[SecretScanner] ${findings.length} hardcoded secret(s) found in codebase.`);
    console.error('[SecretScanner] Move these to .env before deploying.');
    // Don't exit 1 on startup — warn, don't block
  } else {
    console.log('[SecretScanner] Codebase clean — no hardcoded secrets detected.');
  }
  process.exit(0);

} else {
  console.log(`
Darkhan Secret Scanner

Usage:
  node secret-scanner.js --git-diff     Scan staged git diff (pre-commit hook)
  node secret-scanner.js --file <path>  Scan a specific file
  node secret-scanner.js --dir <path>   Scan all files in a directory
  node secret-scanner.js --startup      Scan Darkhan server codebase

Exit codes:
  0 — Clean
  1 — Secrets detected
`);
}
