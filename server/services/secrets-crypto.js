/**
 * Darkhan — Secrets Encryption Service
 *
 * Provides AES-256-GCM encryption for sensitive data at rest in secrets.db.
 * Key is derived from SESSION_SECRET via HKDF — no additional env var needed.
 *
 * Used for: API keys (encrypted + HMAC for lookup), secret_settings values.
 * NOT used for: password hashes (bcrypt is already one-way).
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM standard
const TAG_LENGTH = 16;      // GCM auth tag
const KEY_LENGTH = 32;      // AES-256
const HMAC_ALGO = 'sha256';

class SecretsCrypto {
  /**
   * @param {string} sessionSecret - SESSION_SECRET from env (already required by server)
   */
  constructor(sessionSecret) {
    if (!sessionSecret) {
      throw new Error('SecretsCrypto requires SESSION_SECRET');
    }
    // Derive separate keys for encryption and HMAC via HKDF
    this.encryptionKey = crypto.hkdfSync('sha256', sessionSecret, 'darkhan-secrets-enc', 'encryption', KEY_LENGTH);
    this.hmacKey = crypto.hkdfSync('sha256', sessionSecret, 'darkhan-secrets-hmac', 'hmac', KEY_LENGTH);
  }

  /**
   * Encrypt a plaintext value with AES-256-GCM.
   * Returns base64-encoded string: iv:ciphertext:authTag
   * @param {string} plaintext
   * @returns {string} encrypted value
   */
  encrypt(plaintext) {
    if (!plaintext) return plaintext;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();
    // Format: base64(iv):base64(ciphertext):base64(tag)
    return `${iv.toString('base64')}:${encrypted}:${tag.toString('base64')}`;
  }

  /**
   * Decrypt an encrypted value.
   * @param {string} encryptedValue - format: iv:ciphertext:authTag (all base64)
   * @returns {string} plaintext
   */
  decrypt(encryptedValue) {
    if (!encryptedValue) return encryptedValue;
    // Handle unencrypted legacy values (not in iv:ct:tag format)
    if (!encryptedValue.includes(':')) return encryptedValue;
    const parts = encryptedValue.split(':');
    if (parts.length !== 3) return encryptedValue; // Legacy unencrypted

    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return encryptedValue;

      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(parts[1], 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      // Decryption failed — likely a legacy unencrypted value
      return encryptedValue;
    }
  }

  /**
   * Compute deterministic HMAC for a value (used for indexed lookups).
   * @param {string} value
   * @returns {string} hex-encoded HMAC
   */
  hmac(value) {
    if (!value) return null;
    return crypto.createHmac(HMAC_ALGO, this.hmacKey).update(value).digest('hex');
  }

  /**
   * Check if a value appears to be encrypted (iv:ct:tag format).
   * @param {string} value
   * @returns {boolean}
   */
  isEncrypted(value) {
    if (!value || !value.includes(':')) return false;
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    try {
      const iv = Buffer.from(parts[0], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      return iv.length === IV_LENGTH && tag.length === TAG_LENGTH;
    } catch {
      return false;
    }
  }
}

module.exports = SecretsCrypto;
