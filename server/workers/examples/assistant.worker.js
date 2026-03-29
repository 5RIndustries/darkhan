/**
 * Example Assistant Worker
 *
 * A simple agent worker that demonstrates the core Darkhan worker capabilities:
 *   - Scheduled tasks (morning digest, heartbeat)
 *   - Message listeners (comms check, @mention handler)
 *   - LLM integration with error handling
 *   - Posting to channels
 *
 * To use this worker:
 *   1. Copy it to server/workers/assistant.worker.js
 *   2. Add an agent entry in darkhan.config.json with "worker": "assistant.worker.js"
 *   3. Restart Darkhan
 *
 * See WORKER-CONTRACT.md for the full runtime specification.
 */

module.exports = {
  id: 'agent_assistant',  // Must match the agent ID in darkhan.config.json
  name: 'Assistant',

  /**
   * Called once when the worker loads at server start.
   * Use this to announce the agent is online.
   */
  async onLoad({ darkhan, log }) {
    log.info('Assistant worker loaded');
    await darkhan.post('chan_command', 'Assistant online and ready.');
  },

  tasks: {
    /**
     * Morning digest — runs daily at 9:00 AM.
     * Asks the LLM for a summary of what the team should focus on.
     */
    morning_digest: {
      schedule: '0 9 * * *',  // 9 AM daily
      timeout: 120000,         // 2 minutes max
      retryOnFail: false,
      runOnLoad: false,

      async run({ llm, darkhan, tools, log }) {
        log.info('Running morning digest');

        try {
          // Example: read a project status file and summarize it
          let context = '';
          try {
            context = await tools.fs.read('project/status.md');
          } catch (e) {
            context = 'No status file found. Provide a general morning checklist.';
          }

          const result = await llm.complete({
            messages: [
              {
                role: 'user',
                content: `Based on the following project status, write a brief morning digest (3-5 bullet points) of what the team should focus on today:\n\n${context}`,
              },
            ],
            options: { temperature: 0.3, maxTokens: 500 },
          });

          await darkhan.post('chan_command', `**Morning Digest**\n\n${result.response}`);
          log.info('Morning digest posted');
        } catch (e) {
          if (e.name === 'BudgetExceededError') {
            log.warn('Daily LLM budget exceeded, skipping morning digest');
            await darkhan.post('chan_command', 'Morning digest skipped — daily LLM budget reached.');
            return;
          }
          throw e;
        }
      },
    },

    /**
     * Heartbeat — required for health monitoring.
     * Runs every 5 minutes. The Health dashboard uses this to show
     * green/amber/red status lights for each agent.
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
     * Comms check — convention: all workers respond to "comms check".
     * This lets humans verify that all agents are online and listening.
     */
    comms_check: {
      patterns: [/^comms?\s*check$/i],
      timeout: 15000,

      async run({ darkhan }, { channelId }) {
        await darkhan.post(channelId, 'Assistant standing by.');
      },
    },

    /**
     * Mention handler — responds when someone @mentions this agent.
     * Uses the LLM to generate a helpful response.
     */
    mention: {
      patterns: [/@assistant/i],
      timeout: 60000,

      async run({ llm, darkhan, log }, { channelId, fromUser, body }) {
        log.info(`Mentioned by ${fromUser}: ${body.substring(0, 100)}`);

        try {
          const result = await llm.complete({
            messages: [
              {
                role: 'user',
                content: `A team member said: "${body}"\n\nProvide a brief, helpful response.`,
              },
            ],
            options: { temperature: 0.5, maxTokens: 300 },
          });

          await darkhan.post(channelId, result.response);
        } catch (e) {
          if (e.name === 'BudgetExceededError') {
            await darkhan.post(channelId, 'Daily LLM budget reached. I can respond again tomorrow.');
            return;
          }
          log.error(`Mention handler error: ${e.message}`);
          await darkhan.post(channelId, 'I encountered an error processing that request.');
        }
      },
    },
  },
};
