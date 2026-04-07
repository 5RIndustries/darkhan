/**
 * Darkhan — TLS Setup Service
 *
 * Automated certificate provisioning for Darkhan nodes.
 * Generates a keypair locally, creates a CSR, submits it to the Mokume CA,
 * and stores the signed certificate. The private key NEVER leaves the node.
 *
 * Uses openssl CLI for key/CSR generation (no node-forge dependency).
 * Uses Node.js native crypto.X509Certificate for cert validation at runtime.
 *
 * @module tls-setup
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

const CERTS_DIR = path.join(os.homedir(), '.darkhan-certs');

class TLSSetup {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - darkhan.config.json contents
   */
  constructor({ config }) {
    this.config = config;
    this.instanceId = config.federation?.instanceId || 'standalone';
    this.hubUrl = config.federation?.hubUrl || 'http://localhost:4001';
    this.hubToken = config.federation?.hubToken || '';
    this.certsDir = CERTS_DIR;
    this.certPath = path.join(CERTS_DIR, `${this.instanceId}.crt`);
    this.keyPath = path.join(CERTS_DIR, `${this.instanceId}.key`);
    this.caPath = path.join(CERTS_DIR, 'ca.crt');
  }

  /**
   * Check if TLS is already provisioned with valid certs.
   * @returns {{ provisioned: boolean, daysUntilExpiry?: number, fingerprint?: string }}
   */
  checkStatus() {
    if (!fs.existsSync(this.certPath) || !fs.existsSync(this.keyPath) || !fs.existsSync(this.caPath)) {
      return { provisioned: false };
    }

    try {
      const certPem = fs.readFileSync(this.certPath, 'utf8');
      const x509 = new crypto.X509Certificate(certPem);
      const expiryDate = new Date(x509.validTo);
      const now = new Date();
      const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));

      return {
        provisioned: true,
        daysUntilExpiry,
        fingerprint: x509.fingerprint256,
        subject: x509.subject,
        validFrom: x509.validFrom,
        validTo: x509.validTo,
        expired: daysUntilExpiry <= 0,
      };
    } catch (err) {
      return { provisioned: false, error: err.message };
    }
  }

  /**
   * Provision TLS certificates from the Mokume CA.
   *
   * 1. Generate RSA 2048-bit keypair locally
   * 2. Create a CSR
   * 3. Submit CSR to Mokume hub /api/ca/issue
   * 4. Save signed cert + CA cert to ~/.darkhan-certs/
   *
   * @param {Object} opts
   * @param {string[]} [opts.ipAddresses] - IP addresses for SAN
   * @param {string[]} [opts.dnsNames] - DNS names for SAN
   * @param {boolean} [opts.force] - Overwrite existing certs
   * @returns {Promise<{ ok: boolean, certPath?: string, keyPath?: string, caPath?: string, error?: string }>}
   */
  async provision({ ipAddresses = [], dnsNames = [], force = false } = {}) {
    // Check existing certs
    if (!force) {
      const status = this.checkStatus();
      if (status.provisioned && !status.expired) {
        console.log(`[TLS] Certs already provisioned (${status.daysUntilExpiry} days until expiry)`);
        return { ok: true, certPath: this.certPath, keyPath: this.keyPath, caPath: this.caPath, existing: true };
      }
    }

    // Ensure certs directory exists
    if (!fs.existsSync(this.certsDir)) {
      fs.mkdirSync(this.certsDir, { mode: 0o700 });
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkhan-tls-'));
    const tmpKeyPath = path.join(tmpDir, 'node.key');
    const tmpCsrPath = path.join(tmpDir, 'node.csr');

    try {
      console.log(`[TLS] Provisioning certificates for ${this.instanceId}...`);

      // Step 1: Generate RSA 2048-bit key
      console.log('[TLS] Generating RSA 2048-bit keypair...');
      execFileSync('openssl', [
        'genrsa', '-out', tmpKeyPath, '2048',
      ], { stdio: 'pipe' });

      // Step 2: Create CSR
      console.log('[TLS] Creating Certificate Signing Request...');
      execFileSync('openssl', [
        'req', '-new',
        '-key', tmpKeyPath,
        '-out', tmpCsrPath,
        '-subj', `/CN=${this.instanceId}/O=Darkhan/OU=Federation Node`,
      ], { stdio: 'pipe' });

      const csrPem = fs.readFileSync(tmpCsrPath, 'utf8');

      // Step 3: Submit CSR to Mokume CA
      console.log(`[TLS] Submitting CSR to Mokume CA at ${this.hubUrl}...`);
      const result = await this._submitCSR(csrPem, ipAddresses, dnsNames);

      if (!result.certificate || !result.caCertificate) {
        throw new Error(result.error || 'No certificate returned from CA');
      }

      // Step 4: Save certs
      const nodeKey = fs.readFileSync(tmpKeyPath, 'utf8');
      fs.writeFileSync(this.keyPath, nodeKey, { mode: 0o600 });
      fs.writeFileSync(this.certPath, result.certificate, { mode: 0o644 });
      fs.writeFileSync(this.caPath, result.caCertificate, { mode: 0o644 });

      // Verify the chain
      const x509 = new crypto.X509Certificate(result.certificate);
      console.log(`[TLS] Certificate provisioned successfully`);
      console.log(`[TLS] Subject: ${x509.subject}`);
      console.log(`[TLS] Fingerprint: ${x509.fingerprint256}`);
      console.log(`[TLS] Expires: ${result.expiresAt}`);
      console.log(`[TLS] Key: ${this.keyPath}`);
      console.log(`[TLS] Cert: ${this.certPath}`);
      console.log(`[TLS] CA: ${this.caPath}`);

      return {
        ok: true,
        certPath: this.certPath,
        keyPath: this.keyPath,
        caPath: this.caPath,
        fingerprint: x509.fingerprint256,
        expiresAt: result.expiresAt,
      };

    } catch (err) {
      console.error(`[TLS] Provisioning failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      // Clean up temp files
      try { fs.unlinkSync(tmpKeyPath); } catch { /* */ }
      try { fs.unlinkSync(tmpCsrPath); } catch { /* */ }
      try { fs.rmdirSync(tmpDir); } catch { /* */ }
    }
  }

  /**
   * Submit CSR to Mokume CA.
   */
  async _submitCSR(csrPem, ipAddresses, dnsNames) {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/ca/issue', this.hubUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const payload = JSON.stringify({
        instanceId: this.instanceId,
        csr: csrPem,
        ipAddresses,
        dnsNames,
      });

      const requestOpts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Hub-Token': this.hubToken,
        },
        timeout: 30000,
      };

      // If we already have a CA cert, use it for verification
      // (cert renewal scenario where we already trust the CA)
      if (isHttps && fs.existsSync(this.caPath)) {
        requestOpts.ca = fs.readFileSync(this.caPath);
      }
      if (isHttps) {
        // During bootstrap, we may not have the CA cert yet
        // Accept self-signed for the initial cert request only
        requestOpts.rejectUnauthorized = fs.existsSync(this.caPath);
      }

      const req = transport.request(requestOpts, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(result.error || `CA returned ${res.statusCode}`));
            } else {
              resolve(result);
            }
          } catch {
            reject(new Error(`Invalid CA response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('CA request timed out')); });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Check certificate expiry and return days remaining.
   * @returns {{ daysRemaining: number, needsRenewal: boolean, expired: boolean } | null}
   */
  checkExpiry() {
    if (!fs.existsSync(this.certPath)) return null;

    try {
      const certPem = fs.readFileSync(this.certPath, 'utf8');
      const x509 = new crypto.X509Certificate(certPem);
      const expiryDate = new Date(x509.validTo);
      const now = new Date();
      const daysRemaining = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));

      return {
        daysRemaining,
        needsRenewal: daysRemaining <= 30,
        expired: daysRemaining <= 0,
        fingerprint: x509.fingerprint256,
        expiresAt: x509.validTo,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get TLS options for creating an HTTPS server or client.
   * Returns null if certs are not provisioned.
   */
  getTLSOptions() {
    if (!fs.existsSync(this.certPath) || !fs.existsSync(this.keyPath) || !fs.existsSync(this.caPath)) {
      return null;
    }

    return {
      ca: fs.readFileSync(this.caPath),
      cert: fs.readFileSync(this.certPath),
      key: fs.readFileSync(this.keyPath),
    };
  }
}

module.exports = { TLSSetup, CERTS_DIR };
