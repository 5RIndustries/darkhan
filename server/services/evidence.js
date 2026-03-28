/**
 * Darkhan -- Evidence Service
 *
 * Structured evidence-based reporting. Every factual claim in a Darkhan report
 * is backed by a code-level check with a tamper-detection hash.
 *
 * The LLM formats and analyzes findings but CANNOT add, remove, or alter them.
 * Reports clearly separate verified facts from LLM-generated advisory.
 *
 * Evidence chain:
 *   1. Worker calls evidence.check({ claim, method, target, check })
 *   2. The check function runs (fs.stat, DB query, pgrep, etc.)
 *   3. Result is recorded with SHA-256 hash of (claim + method + result + timestamp)
 *   4. Evidence is appended to the immutable activity log
 *   5. evidence.buildReport() produces a deterministic facts section
 *   6. LLM only touches the "Analysis" section, clearly labeled as advisory
 */

const crypto = require('crypto');

class EvidenceService {
  constructor({ activityLog }) {
    if (!activityLog) {
      throw new Error('EvidenceService requires activityLog');
    }
    this.activityLog = activityLog;
  }

  /**
   * Execute a verifiable check and record the evidence.
   *
   * @param {Object} opts
   * @param {string} opts.claim - What is being asserted (e.g., "File .env has 600 permissions")
   * @param {string} opts.method - How it is checked (e.g., "fs.stat", "sqlite3 query", "pgrep")
   * @param {string} opts.target - What is being checked (file path, process name, etc.)
   * @param {Function} opts.check - Async function that returns { pass: boolean, actual: any, [detail]: any }
   *
   * @returns {Object} Evidence record:
   *   { claim, method, target, result: { pass, actual, detail? }, timestamp, hash, error? }
   */
  async check({ claim, method, target, check }) {
    if (!claim || !method || typeof check !== 'function') {
      throw new Error('evidence.check() requires claim, method, and check function');
    }

    const timestamp = new Date().toISOString();
    let result;

    try {
      result = await check();

      // Normalize result -- must have pass and actual
      if (typeof result !== 'object' || result === null) {
        result = { pass: !!result, actual: result };
      }
      if (typeof result.pass !== 'boolean') {
        result.pass = !!result.pass;
      }
    } catch (err) {
      result = {
        pass: false,
        actual: null,
        error: err.message,
      };
    }

    // Build the hash: SHA-256 of (claim + method + JSON(result) + timestamp)
    const hashInput = `${claim}|${method}|${JSON.stringify(result)}|${timestamp}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const evidence = {
      claim,
      method,
      target: target || null,
      result,
      timestamp,
      hash,
    };

    // Record in the immutable activity log
    this.activityLog.append({
      actor: 'evidence_service',
      action: 'evidence_check',
      target: target || claim,
      details: JSON.stringify({
        claim,
        method,
        pass: result.pass,
        actual: result.actual,
        error: result.error || null,
        hash,
      }),
    });

    return evidence;
  }

  /**
   * Build a structured report from an array of evidence checks.
   * The facts section is deterministic -- produced entirely from evidence data.
   * The analysis section is clearly labeled as LLM-generated advisory.
   *
   * @param {Object} opts
   * @param {string} opts.title - Report title (e.g., "Security Report", "Daily Audit")
   * @param {Array} opts.findings - Array of evidence records from check()
   * @param {string} [opts.llmAnalysis] - Optional LLM-generated analysis text
   * @param {Object} [opts.metadata] - Optional metadata (agent, system, audit type)
   *
   * @returns {string} Formatted markdown report
   */
  buildReport({ title, findings, llmAnalysis = null, metadata = {} }) {
    if (!findings || !Array.isArray(findings)) {
      throw new Error('buildReport() requires a findings array');
    }

    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toISOString();

    // Count results
    const passed = findings.filter(f => f.result.pass).length;
    const failed = findings.filter(f => !f.result.pass).length;
    const errors = findings.filter(f => f.result.error).length;

    // Build the verified findings section
    const findingsLines = findings.map((f, i) => {
      const status = f.result.error
        ? 'ERROR'
        : f.result.pass ? 'PASS' : 'FAIL';
      const statusIcon = f.result.error
        ? '[ERROR]'
        : f.result.pass ? '[PASS]' : '[FAIL]';

      let line = `${i + 1}. ${statusIcon} **${f.claim}**\n`;
      line += `   - Method: \`${f.method}\``;
      if (f.target) line += ` on \`${f.target}\``;
      line += '\n';
      line += `   - Actual: \`${JSON.stringify(f.result.actual)}\`\n`;
      if (f.result.detail) {
        line += `   - Detail: ${JSON.stringify(f.result.detail)}\n`;
      }
      if (f.result.error) {
        line += `   - Error: ${f.result.error}\n`;
      }
      line += `   - Checked: ${f.timestamp}`;

      return line;
    });

    // Build the evidence hashes section
    const hashLines = findings.map((f, i) => {
      const status = f.result.error ? 'ERROR' : f.result.pass ? 'PASS' : 'FAIL';
      return `${i + 1}. [${status}] \`${f.hash}\` -- ${f.claim}`;
    });

    // Assemble the report
    const parts = [];

    // Header
    parts.push(`## ${title} -- ${date}`);
    if (metadata.agent) parts.push(`**Agent:** ${metadata.agent}`);
    if (metadata.system) parts.push(`**System:** ${metadata.system}`);
    if (metadata.auditType) parts.push(`**Audit type:** ${metadata.auditType}`);
    parts.push(`**Generated:** ${time}`);
    parts.push(`**Summary:** ${passed} passed, ${failed} failed, ${errors} errors out of ${findings.length} checks`);
    parts.push('');

    // Verified findings
    parts.push('### Verified Findings (code-checked, evidence-logged)');
    parts.push('');
    parts.push(findingsLines.join('\n\n'));
    parts.push('');

    // Evidence hashes
    parts.push('### Evidence Hashes');
    parts.push('');
    parts.push('Each hash is SHA-256 of (claim + method + result + timestamp). Cross-reference against `evidence_check` entries in the activity log for tamper verification.');
    parts.push('');
    parts.push(hashLines.join('\n'));
    parts.push('');

    // LLM analysis (if provided)
    if (llmAnalysis) {
      parts.push('### Analysis (LLM-generated -- advisory only, not verified fact)');
      parts.push('');
      parts.push('> The following analysis was generated by an LLM based on the verified findings above.');
      parts.push('> It is interpretive commentary, not code-verified fact. Treat accordingly.');
      parts.push('');
      parts.push(llmAnalysis);
      parts.push('');
    }

    // Footer
    parts.push('---');
    parts.push(`*Evidence-based report generated by Darkhan EvidenceService. ${findings.length} checks logged to immutable activity trail.*`);

    return parts.join('\n');
  }

  /**
   * Convenience: build the raw findings summary (for passing to LLM).
   * Returns a plain-text summary of PASS/FAIL results only -- no hashes, no formatting.
   * This is what the LLM receives to generate its analysis section.
   *
   * @param {Array} findings - Array of evidence records from check()
   * @returns {string} Plain-text summary for LLM consumption
   */
  buildFindingsSummary(findings) {
    if (!findings || !Array.isArray(findings)) return '';

    return findings.map(f => {
      const status = f.result.error ? 'ERROR' : f.result.pass ? 'PASS' : 'FAIL';
      let line = `[${status}] ${f.claim}`;
      line += ` (method: ${f.method}`;
      if (f.target) line += `, target: ${f.target}`;
      line += `, actual: ${JSON.stringify(f.result.actual)}`;
      if (f.result.error) line += `, error: ${f.result.error}`;
      line += ')';
      return line;
    }).join('\n');
  }
}

module.exports = { EvidenceService };
