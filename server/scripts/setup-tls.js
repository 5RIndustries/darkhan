#!/usr/bin/env node
/**
 * Darkhan — TLS Setup CLI
 *
 * One-command certificate provisioning for a Darkhan node.
 * Generates a keypair, submits a CSR to the Mokume CA, and saves the signed cert.
 *
 * Usage:
 *   node scripts/setup-tls.js [options]
 *
 * Options:
 *   --ip <addr>      IP address for SAN (can be repeated)
 *   --dns <name>     DNS name for SAN (can be repeated)
 *   --force          Overwrite existing certificates
 *   --status         Check current TLS status and exit
 *
 * Examples:
 *   node scripts/setup-tls.js --ip 192.168.1.50 --ip 127.0.0.1
 *   node scripts/setup-tls.js --status
 *   node scripts/setup-tls.js --force --ip 10.0.0.5 --dns mynode.local
 */

const path = require('path');
const fs = require('fs');

// Load config
const configPath = path.join(__dirname, '..', 'darkhan.config.json');
if (!fs.existsSync(configPath)) {
  console.error('Error: darkhan.config.json not found at', configPath);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { TLSSetup } = require('../services/tls-setup');
const tls = new TLSSetup({ config });

// Parse args
const args = process.argv.slice(2);
const ipAddresses = [];
const dnsNames = [];
let force = false;
let statusOnly = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--ip':
      ipAddresses.push(args[++i]);
      break;
    case '--dns':
      dnsNames.push(args[++i]);
      break;
    case '--force':
      force = true;
      break;
    case '--status':
      statusOnly = true;
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Darkhan TLS Setup');
  console.log('='.repeat(60));
  console.log(`  Instance: ${tls.instanceId}`);
  console.log(`  Hub URL:  ${tls.hubUrl}`);
  console.log(`  Certs:    ${tls.certsDir}`);
  console.log('');

  // Status check
  const status = tls.checkStatus();
  if (status.provisioned) {
    console.log('  Current certificate:');
    console.log(`    Subject:     ${status.subject}`);
    console.log(`    Fingerprint: ${status.fingerprint}`);
    console.log(`    Valid from:  ${status.validFrom}`);
    console.log(`    Valid to:    ${status.validTo}`);
    console.log(`    Days left:   ${status.daysUntilExpiry}`);
    console.log(`    Status:      ${status.expired ? 'EXPIRED' : status.daysUntilExpiry <= 30 ? 'RENEWAL NEEDED' : 'VALID'}`);
  } else {
    console.log('  No certificates provisioned yet.');
  }
  console.log('');

  if (statusOnly) {
    process.exit(0);
  }

  if (status.provisioned && !status.expired && !force) {
    console.log('  Certificates are valid. Use --force to regenerate.');
    process.exit(0);
  }

  // Always add localhost
  if (!ipAddresses.includes('127.0.0.1')) {
    ipAddresses.push('127.0.0.1');
  }

  console.log(`  Requesting certificate with SANs:`);
  for (const ip of ipAddresses) console.log(`    IP:  ${ip}`);
  for (const dns of dnsNames) console.log(`    DNS: ${dns}`);
  console.log('');

  // Provision
  const result = await tls.provision({ ipAddresses, dnsNames, force });

  if (!result.ok) {
    console.error(`  FAILED: ${result.error}`);
    process.exit(1);
  }

  if (result.existing) {
    console.log('  Using existing valid certificates.');
    process.exit(0);
  }

  // Update darkhan.config.json to enable TLS
  console.log('');
  console.log('  Updating darkhan.config.json...');
  config.tls = {
    enabled: true,
    ca: result.caPath,
    cert: result.certPath,
    key: result.keyPath,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('  TLS enabled in config.');

  console.log('');
  console.log('='.repeat(60));
  console.log('  TLS Setup Complete');
  console.log('='.repeat(60));
  console.log(`  Certificate: ${result.certPath}`);
  console.log(`  Key:         ${result.keyPath}`);
  console.log(`  CA:          ${result.caPath}`);
  console.log(`  Fingerprint: ${result.fingerprint}`);
  console.log(`  Expires:     ${result.expiresAt}`);
  console.log('');
  console.log('  Restart Darkhan to activate HTTPS:');
  console.log('    kill $(pgrep -f "node.*server.js") && node server/server.js');
  console.log('');
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
