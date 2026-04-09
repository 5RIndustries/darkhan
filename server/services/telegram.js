/**
 * Darkhan — Telegram Bridge Service
 *
 * Bridges messages between Telegram groups/chats and Darkhan channels.
 * Uses the Telegram Bot API directly (no external dependencies).
 *
 * Architecture:
 *   - Long-polling for incoming Telegram messages (getUpdates)
 *   - HTTPS POST for outgoing messages (sendMessage)
 *   - Configurable channel mapping (Telegram chat_id <-> Darkhan channel_id)
 *   - Identity preservation: Telegram usernames shown in Darkhan, Darkhan agent names shown in Telegram
 *   - Security: messages from Telegram are scanned for injection before reaching Darkhan
 *
 * Configuration (in darkhan.config.json):
 *   "telegram": {
 *     "enabled": true,
 *     "botToken": "ENV:TELEGRAM_BOT_TOKEN",
 *     "channelMap": [
 *       { "telegramChatId": "-100123456789", "darkhanChannelId": "chan_coordination" }
 *     ],
 *     "allowedChatIds": ["-100123456789"],
 *     "pollingIntervalMs": 2000
 *   }
 */

const https = require('https');

const TELEGRAM_API = 'https://api.telegram.org';

class TelegramBridge {
  constructor({ config, activityLog, securityService }) {
    this.activityLog = activityLog;
    this.securityService = securityService;
    this.config = config;

    const tgConfig = config.telegram || {};
    this.enabled = tgConfig.enabled === true;

    if (!this.enabled) {
      console.log('[Telegram] Bridge disabled (telegram.enabled not set in config)');
      return;
    }

    // Resolve bot token from env if specified as "ENV:VAR_NAME"
    let token = tgConfig.botToken || '';
    if (token.startsWith('ENV:')) {
      token = process.env[token.substring(4)] || '';
    }
    this.botToken = token;

    if (!this.botToken) {
      console.warn('[Telegram] Bridge enabled but no bot token configured. Set TELEGRAM_BOT_TOKEN in .env');
      this.enabled = false;
      return;
    }

    // Channel mapping
    this.channelMap = tgConfig.channelMap || [];
    this.allowedChatIds = new Set((tgConfig.allowedChatIds || []).map(String));
    this.pollingInterval = tgConfig.pollingIntervalMs || 2000;

    // State
    this.lastUpdateId = 0;
    this.polling = false;
    this._pollTimer = null;

    // Callbacks set by the worker that uses this service
    this._onMessage = null; // (telegramMsg, darkhanChannelId) => void
    this._db = null;
    this._io = null;

    console.log(`[Telegram] Bridge configured: ${this.channelMap.length} channel mapping(s), ${this.allowedChatIds.size} allowed chat(s)`);
  }

  /**
   * Set the message handler and Darkhan internals for posting.
   */
  setHandler({ onMessage, db, io }) {
    this._onMessage = onMessage;
    this._db = db;
    this._io = io;
  }

  /**
   * Make a Telegram Bot API request.
   */
  _apiCall(method, params = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(params);
      const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`;
      const parsed = new URL(url);

      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) {
              resolve(result.result);
            } else {
              reject(new Error(`Telegram API error: ${result.description || 'unknown'}`));
            }
          } catch (e) {
            reject(new Error(`Telegram API parse error: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Telegram API timeout')); });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send a message to a Telegram chat.
   */
  async sendMessage(chatId, text, options = {}) {
    if (!this.enabled) return null;

    // Truncate if over Telegram's 4096 char limit
    const truncated = text.length > 4000 ? text.substring(0, 4000) + '\n\n[truncated]' : text;

    return this._apiCall('sendMessage', {
      chat_id: chatId,
      text: truncated,
      parse_mode: options.parseMode || 'Markdown',
      disable_web_page_preview: true,
      ...options,
    });
  }

  /**
   * Get the bot's info (for startup verification).
   */
  async getMe() {
    return this._apiCall('getMe');
  }

  /**
   * Start long-polling for incoming messages.
   */
  async startPolling() {
    if (!this.enabled || this.polling) return;

    // Verify bot token works
    try {
      const me = await this.getMe();
      console.log(`[Telegram] Bot online: @${me.username} (${me.first_name})`);
      this.activityLog?.append({
        actor: 'telegram_bridge',
        action: 'bridge_started',
        details: JSON.stringify({ botUsername: me.username }),
      });
    } catch (e) {
      console.error(`[Telegram] Bot verification failed: ${e.message}`);
      this.enabled = false;
      return;
    }

    this.polling = true;
    this._poll();
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    this.polling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Internal polling loop.
   */
  async _poll() {
    if (!this.polling) return;

    try {
      const updates = await this._apiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ['message'],
      });

      for (const update of updates) {
        this.lastUpdateId = update.update_id;
        if (update.message) {
          await this._handleIncoming(update.message);
        }
      }
    } catch (e) {
      // Network error or timeout — retry after interval
      if (!e.message.includes('timeout')) {
        console.warn(`[Telegram] Poll error: ${e.message}`);
      }
    }

    // Schedule next poll
    if (this.polling) {
      this._pollTimer = setTimeout(() => this._poll(), this.pollingInterval);
    }
  }

  /**
   * Handle an incoming Telegram message.
   */
  async _handleIncoming(msg) {
    const chatId = String(msg.chat?.id);
    const text = msg.text || '';
    const from = msg.from?.username || msg.from?.first_name || 'unknown';

    // Security: only process messages from allowed chats
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
      console.log(`[Telegram] Ignored message from unauthorized chat ${chatId}`);
      return;
    }

    // Skip empty messages, bot commands we don't handle, or our own messages
    if (!text || text.startsWith('/')) return;

    // Find the Darkhan channel mapping for this Telegram chat
    const mapping = this.channelMap.find(m => String(m.telegramChatId) === chatId);
    if (!mapping) {
      console.log(`[Telegram] No channel mapping for chat ${chatId}`);
      return;
    }

    // Security: scan for injection before forwarding to Darkhan
    if (this.securityService) {
      const scan = this.securityService.scanForInjection(text, {
        source: `telegram:${from}`,
        origin: 'external',
      });
      if (!scan.safe && scan.severity === 'critical') {
        console.warn(`[Telegram] BLOCKED injection from ${from}: ${scan.threats.join(', ')}`);
        this.activityLog?.append({
          actor: 'telegram_bridge',
          action: 'telegram_injection_blocked',
          target: from,
          details: JSON.stringify({ chatId, threats: scan.threats }),
        });
        return;
      }
    }

    // Format and forward to Darkhan
    const darkhanBody = `**[Telegram] ${from}:** ${text}`;

    if (this._onMessage) {
      await this._onMessage({
        from,
        text,
        chatId,
        messageId: msg.message_id,
        darkhanChannelId: mapping.darkhanChannelId,
        formattedBody: darkhanBody,
      });
    }

    this.activityLog?.append({
      actor: 'telegram_bridge',
      action: 'telegram_message_received',
      target: mapping.darkhanChannelId,
      details: JSON.stringify({ from, chatId, length: text.length }),
    });
  }

  /**
   * Forward a Darkhan message to the mapped Telegram chat.
   * Called by the Telegram worker when a Darkhan channel message should be relayed.
   */
  async relayToTelegram(darkhanChannelId, fromUser, body) {
    if (!this.enabled) return;

    const mapping = this.channelMap.find(m => m.darkhanChannelId === darkhanChannelId);
    if (!mapping) return;

    // Format for Telegram
    const tgText = `*${fromUser}:* ${body}`;

    try {
      await this.sendMessage(mapping.telegramChatId, tgText);
    } catch (e) {
      console.warn(`[Telegram] Failed to relay to chat ${mapping.telegramChatId}: ${e.message}`);
    }
  }

  /**
   * Get bridge status for API/dashboard.
   */
  getStatus() {
    return {
      enabled: this.enabled,
      polling: this.polling,
      channelMappings: this.channelMap.length,
      allowedChats: this.allowedChatIds.size,
      lastUpdateId: this.lastUpdateId,
    };
  }
}

module.exports = { TelegramBridge };
