#!/bin/bash
#
# Darkhan — mTLS Certificate Generator
#
# Generates a self-signed CA and per-node certificates for mutual TLS
# between Darkhan instances. Each node gets a cert signed by the CA,
# and both nodes trust only certs from this CA.
#
# Usage:
#   ./generate-certs.sh [output-dir] [node-name]
#
# Examples:
#   ./generate-certs.sh ~/.darkhan-certs my-primary
#   ./generate-certs.sh ~/.darkhan-certs my-node1
#
# Output:
#   output-dir/ca.crt            — CA certificate (share with all nodes)
#   output-dir/ca.key            — CA private key (keep secure, only needed for signing)
#   output-dir/<node>.crt        — Node certificate (signed by CA)
#   output-dir/<node>.key        — Node private key
#
# Security:
#   - All private keys are generated with 600 permissions
#   - CA key should be stored offline after initial cert generation
#   - Certificates are valid for 365 days (rotate annually)
#   - Subject includes the node name for identity verification

set -euo pipefail

CERT_DIR="${1:-$HOME/.darkhan-certs}"
NODE_NAME="${2:-darkhan-node}"

mkdir -p "$CERT_DIR"
chmod 700 "$CERT_DIR"

echo "=== Darkhan mTLS Certificate Generator ==="
echo "Output: $CERT_DIR"
echo "Node:   $NODE_NAME"
echo ""

# Generate CA if it doesn't exist
if [ ! -f "$CERT_DIR/ca.key" ]; then
  echo "--- Generating CA ---"
  openssl genrsa -out "$CERT_DIR/ca.key" 4096 2>/dev/null
  chmod 600 "$CERT_DIR/ca.key"

  openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca.key" \
    -out "$CERT_DIR/ca.crt" \
    -subj "/O=Darkhan/CN=Darkhan CA" 2>/dev/null

  echo "CA created: $CERT_DIR/ca.crt (valid 10 years)"
else
  echo "CA already exists, reusing."
fi

# Generate node cert
echo ""
echo "--- Generating node certificate: $NODE_NAME ---"

# Private key
openssl genrsa -out "$CERT_DIR/$NODE_NAME.key" 2048 2>/dev/null
chmod 600 "$CERT_DIR/$NODE_NAME.key"

# CSR with SAN (Subject Alternative Names for IP and localhost)
cat > "$CERT_DIR/$NODE_NAME.cnf" <<CONF
[req]
default_bits = 2048
prompt = no
distinguished_name = dn
req_extensions = v3_req

[dn]
O = Darkhan
CN = $NODE_NAME

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = $NODE_NAME
DNS.3 = *.local
IP.1 = 127.0.0.1
# Add your node IPs here (e.g., Tailscale IPs)
# IP.2 = <remote-worker-ip>
# IP.3 = <additional-node-ip>
CONF

openssl req -new -key "$CERT_DIR/$NODE_NAME.key" \
  -out "$CERT_DIR/$NODE_NAME.csr" \
  -config "$CERT_DIR/$NODE_NAME.cnf" 2>/dev/null

# Sign with CA
openssl x509 -req -days 365 \
  -in "$CERT_DIR/$NODE_NAME.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/$NODE_NAME.crt" \
  -extensions v3_req \
  -extfile "$CERT_DIR/$NODE_NAME.cnf" 2>/dev/null

# Cleanup CSR and CNF (no longer needed)
rm -f "$CERT_DIR/$NODE_NAME.csr" "$CERT_DIR/$NODE_NAME.cnf"

echo "Node cert created: $CERT_DIR/$NODE_NAME.crt (valid 1 year)"
echo ""
echo "=== Files ==="
ls -la "$CERT_DIR"/*.crt "$CERT_DIR"/*.key 2>/dev/null
echo ""
echo "=== Next Steps ==="
echo "1. Copy ca.crt to all nodes (both nodes need the CA to verify each other)"
echo "2. Each node gets its own .crt + .key pair"
echo "3. Add to darkhan.config.json:"
echo "   \"tls\": {"
echo "     \"ca\": \"$CERT_DIR/ca.crt\","
echo "     \"cert\": \"$CERT_DIR/$NODE_NAME.crt\","
echo "     \"key\": \"$CERT_DIR/$NODE_NAME.key\""
echo "   }"
echo "4. Set REMOTE_HOST to https:// URL (removes need for FEDERATION_ALLOW_HTTP)"
