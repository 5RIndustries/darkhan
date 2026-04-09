/**
 * Darkhan — Telegram Bridge Worker (Example)
 *
 * Bridges messages between a Telegram group and Darkhan channels.
 * Incoming Telegram messages appear in the mapped Darkhan channel.
 * Darkhan messages in mapped channels are relayed to Telegram.
 *
 * Setup:
 *   1. Create a Telegram bot via @BotFather
 *   2. Add TELEGRAM_BOT_TOKEN to your .env
 *   3. Add the bot to your Telegram group
 *   4. Get the chat ID (send a message, check getUpdates)
 *   5. Configure the telegram section in darkhan.config.json
 *   6. Add this worker to your config with id "agent_telegram"
 *
 * Config example:
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

const { TelegramBridge } = require('../../services/telegram');

let bridge = null;

module.exports = {
  id: 'agent_telegram',
  name: 'Telegram Bridge',

  async onLoad({ darkhan, config, log }) {
    // Initialize the bridge
    bridge = new TelegramBridge({
      config,
      activityLog: null, // Will use darkhan.post for logging instead
      securityService: null, // Injection scanning handled by Darkhan message pipeline
    });

    if (!bridge.enabled) {
      log.info('Telegram bridge not configured — worker idle');
      return;
    }

    // Set up the incoming message handler
    bridge.setHandler({
      onMessage: async ({ from, text, darkhanChannelId, formattedBody }) => {
        // Post the Telegram message to the mapped Darkhan channel
        await darkhan.post(darkhanChannelId, formattedBody);
        log.info(`Telegram -> Darkhan: ${from} in ${darkhanChannelId}`);
      },
    });

    // Start polling for Telegram messages
    await bridge.startPolling();
    await darkhan.post('chan_coordination', 'Telegram bridge online.');
    log.info('Telegram bridge started');
  },

  tasks: {
    /**
     * Relay check — periodically verify the Telegram connection is alive.
     * Runs every 5 minutes.
     */
    health_check: {
      schedule: '*/5 * * * *',
      timeout: 15000,

      async run({ darkhan, log }) {
        if (!bridge || !bridge.enabled) return;

        try {
          const me = await bridge.getMe();
          log.info(`Telegram bot healthy: @${me.username}`);
        } catch (e) {
          log.error(`Telegram bot unhealthy: ${e.message}`);
          await darkhan.alert(`[Telegram] Bot health check failed: ${e.message}`);
        }
      }
    },

    /**
     * Heartbeat — standard worker heartbeat.
     */
    heartbeat: {
      schedule: '*/5 * * * *',
      timeout: 5000,
      async run({ darkhan }) {
        await darkhan.ping('active');
      }
    },
  },

  listeners: {
    /**
     * Comms check — standard response.
     */
    comms_check: {
      patterns: [/^comms?\s*check$/i],
      timeout: 10000,
      async run({ darkhan }, { channelId }) {
        const status = bridge?.getStatus() || { enabled: false };
        const statusText = status.enabled
          ? `Telegram bridge operational (${status.channelMappings} mapping(s), polling: ${status.polling})`
          : 'Telegram bridge not configured';
        await darkhan.post(channelId, statusText);
      }
    },

    /**
     * Relay outbound — when a message is posted to a mapped Darkhan channel,
     * relay it to the corresponding Telegram chat.
     *
     * NOTE: This listener watches for messages in mapped channels and
     * forwards them to Telegram. To avoid infinite loops, it skips
     * messages that originated from Telegram (prefixed with "[Telegram]").
     */
    relay_outbound: {
      patterns: [/.+/], // Match all messages
      timeout: 10000,

      async run({ log }, { channelId, fromUser, body }) {
        if (!bridge || !bridge.enabled) return;

        // Skip messages that came FROM Telegram (prevent echo loop)
        if (body.startsWith('**[Telegram]')) return;

        // Skip bot's own messages
        if (fromUser === 'agent_telegram') return;

        // Relay to Telegram if this channel is mapped
        try {
          await bridge.relayToTelegram(channelId, fromUser, body);
        } catch (e) {
          log.warn(`Telegram relay failed: ${e.message}`);
        }
      }
    },
  }
};
