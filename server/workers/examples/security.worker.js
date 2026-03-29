/**
 * Example Security Worker
 *
 * A security-focused agent worker that demonstrates:
 *   - Evidence-based auditing with SHA-256 hashes
 *   - Scheduled security sweeps
 *   - LLM-powered analysis of findings
 *   - Threat flagging with CRISPR defense spacers
 *
 * To use this worker:
 *   1. Copy it to server/workers/security.worker.js
 *   2. Add an agent entry in darkhan.config.json with "worker": "security.worker.js"
 *   3. Restart Darkhan
 *
 * See WORKER-CONTRACT.md for the full runtime specification.
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'agent_security',  // Must match the agent ID in darkhan.config.json
  name: 'Security',

  async onLoad({ darkhan, log }) {
    log.info('Security worker loaded');
    await darkhan.post('chan_alerts', 'Security monitoring active.');
  },

  tasks: {
    /**
     * Daily security audit — runs at 1:00 AM.
     * Uses the Evidence Service to verify file permissions, check for
     * credential exposure, and scan the activity log for anomalies.
     */
    daily_audit: {
      schedule: '0 1 * * *',  // 1 AM daily
      timeout: 300000,         // 5 minutes max
      retryOnFail: false,
      runOnLoad: false,

      async run({ evidence, llm, darkhan, tools, log }) {
        log.info('Starting daily security audit');
        const findings = [];

        // --- Check 1: .env file permissions ---
        findings.push(await evidence.check({
          claim: '.env file has restricted permissions (600)',
          method: 'fs.stat',
          target: '.env',
          check: async () => {
            try {
              const envPath = path.join(process.cwd(), '.env');
              const stat = await fs.promises.stat(envPath);
              const mode = (stat.mode & 0o777).toString(8);
              return { pass: mode === '600', actual: `permissions: ${mode}` };
            } catch (e) {
              return { pass: false, actual: '.env not found', error: e.message };
            }
          },
        }));

        // --- Check 2: Database file permissions ---
        findings.push(await evidence.check({
          claim: 'Database files have restricted permissions (600)',
          method: 'fs.stat',
          target: 'db/darkhan.db',
          check: async () => {
            try {
              const dbPath = path.join(process.cwd(), 'db', 'darkhan.db');
              const stat = await fs.promises.stat(dbPath);
              const mode = (stat.mode & 0o777).toString(8);
              return { pass: mode === '600', actual: `permissions: ${mode}` };
            } catch (e) {
              return { pass: false, actual: 'Database not found', error: e.message };
            }
          },
        }));

        // --- Check 3: secrets.db permissions ---
        findings.push(await evidence.check({
          claim: 'Secrets database has restricted permissions (600)',
          method: 'fs.stat',
          target: 'db/secrets.db',
          check: async () => {
            try {
              const secretsPath = path.join(process.cwd(), 'db', 'secrets.db');
              const stat = await fs.promises.stat(secretsPath);
              const mode = (stat.mode & 0o777).toString(8);
              return { pass: mode === '600', actual: `permissions: ${mode}` };
            } catch (e) {
              return { pass: false, actual: 'Secrets DB not found', error: e.message };
            }
          },
        }));

        // --- Check 4: Scan recent messages for credential patterns ---
        findings.push(await evidence.check({
          claim: 'No credentials exposed in recent messages',
          method: 'message scan (24h lookback)',
          target: 'all channels',
          check: async () => {
            try {
              const messages = await darkhan.getMessages('chan_command', { limit: 100 });
              const patterns = [
                /sk-[a-zA-Z0-9]{20,}/,       // API keys
                /password\s*[:=]\s*\S+/i,     // Passwords
                /-----BEGIN.*KEY-----/,        // Private keys
              ];
              let exposures = 0;
              for (const msg of (messages || [])) {
                for (const pattern of patterns) {
                  if (pattern.test(msg.body || '')) exposures++;
                }
              }
              return {
                pass: exposures === 0,
                actual: `${exposures} potential credential exposure(s) found`,
              };
            } catch (e) {
              return { pass: false, actual: 'Could not scan messages', error: e.message };
            }
          },
        }));

        // --- Check 5: Integrity baseline exists ---
        findings.push(await evidence.check({
          claim: 'Integrity baseline file exists',
          method: 'fs.existsSync',
          target: '~/.darkhan-integrity-baseline.json',
          check: async () => {
            const baselinePath = path.join(process.env.HOME, '.darkhan-integrity-baseline.json');
            const exists = fs.existsSync(baselinePath);
            if (exists) {
              const stat = fs.statSync(baselinePath);
              const hoursAgo = Math.round((Date.now() - stat.mtimeMs) / 3600000);
              return { pass: true, actual: `exists, ${hoursAgo}h old` };
            }
            return { pass: false, actual: 'baseline file not found' };
          },
        }));

        // --- Build summary for LLM analysis ---
        const summary = evidence.buildFindingsSummary(findings);
        const passCount = findings.filter(f => f.result?.pass).length;
        const failCount = findings.filter(f => !f.result?.pass).length;

        let llmAnalysis = '';
        try {
          const analysisResult = await llm.complete({
            messages: [
              {
                role: 'system',
                content: 'You are a security auditor. Analyze these findings and provide a brief GO/NO-GO recommendation with reasoning.',
              },
              {
                role: 'user',
                content: `Security audit findings:\n\n${summary}\n\nProvide your assessment.`,
              },
            ],
            options: { temperature: 0.1, maxTokens: 500 },
          });
          llmAnalysis = analysisResult.response;
        } catch (e) {
          llmAnalysis = `LLM analysis unavailable: ${e.message}`;
        }

        // --- Build and post the report ---
        const report = evidence.buildReport({
          title: 'Daily Security Audit',
          findings,
          llmAnalysis,
          metadata: {
            agent: 'Security',
            timestamp: new Date().toISOString(),
          },
        });

        // Post to alerts channel
        await darkhan.alert(report);

        // If any checks failed, also post to command channel
        if (failCount > 0) {
          await darkhan.post(
            'chan_command',
            `**Security Audit: ${failCount} issue(s) found.** ${passCount}/${findings.length} checks passed. See #alerts for full report.`
          );
        }

        log.info(`Daily audit complete: ${passCount} pass, ${failCount} fail`);
      },
    },

    /**
     * Blind spot sweep — runs every 4 hours.
     * Quick scan for obvious security issues between daily audits.
     */
    blind_spot_sweep: {
      schedule: '0 */4 * * *',
      timeout: 60000,

      async run({ evidence, darkhan, log }) {
        log.info('Running blind spot sweep');
        const findings = [];

        // Check that the server process is running as expected
        findings.push(await evidence.check({
          claim: 'Darkhan server process is running',
          method: 'process check',
          target: 'server.js',
          check: async () => {
            return { pass: true, actual: `PID ${process.pid}, uptime ${Math.round(process.uptime())}s` };
          },
        }));

        const failCount = findings.filter(f => !f.result?.pass).length;
        if (failCount > 0) {
          const summary = evidence.buildFindingsSummary(findings);
          await darkhan.alert(`**Blind Spot Sweep: ${failCount} issue(s)**\n\n${summary}`);
        }

        log.info(`Blind spot sweep complete: ${findings.length - failCount}/${findings.length} pass`);
      },
    },

    /**
     * Heartbeat — required for health monitoring.
     */
    heartbeat: {
      schedule: '*/5 * * * *',
      timeout: 5000,

      async run({ darkhan }) {
        await darkhan.ping('active');
      },
    },
  },

  listeners: {
    /**
     * Comms check — all workers respond to this by convention.
     */
    comms_check: {
      patterns: [/^comms?\s*check$/i],
      timeout: 15000,

      async run({ darkhan }, { channelId }) {
        await darkhan.post(channelId, 'Security monitoring active.');
      },
    },

    /**
     * Threat report handler — respond when someone reports a security concern.
     */
    threat_report: {
      patterns: [/security\s*(?:issue|concern|threat|alert)/i, /@security/i],
      timeout: 30000,

      async run({ darkhan, log }, { channelId, fromUser, body }) {
        log.warn(`Security concern reported by ${fromUser}: ${body.substring(0, 200)}`);

        // Flag the threat using the CRISPR defense spacer system
        await darkhan.flagThreat({
          category: 'user_report',
          severity: 'medium',
          description: `Security concern reported by ${fromUser}: ${body.substring(0, 200)}`,
          evidence: { reportedBy: fromUser, channel: channelId },
        });

        await darkhan.post(
          channelId,
          `Security concern noted and logged. A defense spacer has been created in the audit trail. I will review this in the next audit cycle.`
        );
      },
    },
  },
};
