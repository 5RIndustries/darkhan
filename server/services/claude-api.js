/**
 * DEPRECATED — 2026-03-27
 *
 * This module was the original Anthropic API integration for DARYL's Sonnet tier.
 * It has been replaced by:
 *   - auto-responder.js: Local LLM (Ollama) + Claude CLI relay (Max plan, $0)
 *   - agent-relay.js: Agent SDK relay (alternative to CLI)
 *
 * This file is kept for reference. It is only imported by routes/claude.js
 * (also deprecated). Neither is called in normal message routing.
 *
 * Safe to delete when ready to clean up legacy code.
 *
 * --- Original description ---
 * Maintains conversation threads with Claude via the Anthropic Messages API.
 * Handles tool execution, conversation persistence, and token management.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { executeTool } = require('./tool-executor');

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// System prompt (cached after first load)
let systemPrompt = null;

/**
 * Load the system prompt from CLAUDE.md
 * Path: CLAUDE_PROMPT_PATH env var, or default to ~/darkhan-vault/CLAUDE.md
 */
function loadSystemPrompt() {
  if (systemPrompt) return systemPrompt;

  const promptPath = process.env.CLAUDE_PROMPT_PATH || 
    path.join(process.env.HOME || '/root', 'darkhan-vault/CLAUDE.md');

  try {
    const content = fs.readFileSync(promptPath, 'utf8');
    systemPrompt = content;
    console.log(`[Claude API] Loaded system prompt from ${promptPath}`);
    return systemPrompt;
  } catch (err) {
    console.warn(`[Claude API] Failed to load system prompt from ${promptPath}:`, err.message);
    // Fallback system prompt
    systemPrompt = `You are Darkhan, the command center assistant.
You handle fast responses: comms checks, greetings, simple status. Be concise and direct.`;
    return systemPrompt;
  }
}

/**
 * Define tools Claude can use
 */
function getToolDefinitions() {
  return [
    {
      name: 'send_message',
      description: 'Post a message to a DARYL channel',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'Channel ID (e.g., "chan_command", "chan_alerts")'
          },
          body: {
            type: 'string',
            description: 'Message text'
          }
        },
        required: ['channel_id', 'body']
      }
    },
    {
      name: 'create_task',
      description: 'Create a task in DARYL',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Task title'
          },
          description: {
            type: 'string',
            description: 'Task description (optional)'
          },
          assignee: {
            type: 'string',
            description: 'User ID of assignee'
          },
          priority: {
            type: 'integer',
            enum: [1, 2, 3, 4],
            description: '1=critical, 2=high, 3=normal, 4=low'
          }
        },
        required: ['title', 'assignee']
      }
    },
    {
      name: 'read_file',
      description: 'Read a file from the vault (Obsidian directory)',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative path (e.g., "project/status.md")'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Write a file to the vault. If outside allowlist, queued for admin approval.',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative path (e.g., "project/output/my-research.md")'
          },
          content: {
            type: 'string',
            description: 'File content'
          }
        },
        required: ['path', 'content']
      }
    }
  ];
}

/**
 * Load conversation history from database
 * Returns messages in Anthropic format: [{ role, content }, ...]
 */
function loadConversationHistory(db, channelId) {
  return new Promise((resolve) => {
    db.all(
      `SELECT role, content, tool_use FROM claude_conversations
       WHERE channel_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC`,
      [channelId],
      (err, rows) => {
        if (err) {
          console.error('[Claude API] History load error:', err.message);
          return resolve([]);
        }

        const messages = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const msg = { role: row.role, content: row.content };
          if (row.tool_use) {
            // Parse tool use blocks if present
            try {
              const toolUseContent = JSON.parse(row.tool_use);
              // Only include tool_use if next message is a tool_result
              const nextRow = rows[i + 1];
              if (nextRow && nextRow.role === 'user') {
                msg.content = toolUseContent;
              }
              // Skip orphaned tool_use entries (no matching tool_result)
              // Fall back to text content only
            } catch (e) {
              msg.content = row.content;
            }
          }
          messages.push(msg);
        }

        resolve(messages);
      }
    );
  });
}

/**
 * Estimate token count (approximate)
 * Rough rule: ~4 chars per token on average
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Prune conversation history to stay within token budget
 * Sliding window: drop oldest messages first, always keep system prompt
 * Budget: 150k tokens (aiming for ~120k to leave headroom)
 */
function pruneHistory(messages, maxTokens = 150000, targetTokens = 120000) {
  const systemPromptTokens = estimateTokens(loadSystemPrompt());
  let totalTokens = systemPromptTokens;

  // Count tokens in all messages
  for (const msg of messages) {
    totalTokens += estimateTokens(JSON.stringify(msg));
  }

  if (totalTokens <= targetTokens) {
    return messages; // No pruning needed
  }

  // Prune from the beginning (oldest first)
  while (messages.length > 0 && totalTokens > targetTokens) {
    const removed = messages.shift();
    totalTokens -= estimateTokens(JSON.stringify(removed));
  }

  console.log(`[Claude API] Pruned history to ${messages.length} messages (${totalTokens} tokens)`);
  return messages;
}

/**
 * Send a message to Claude and get a response
 * 
 * channelId: DARYL channel ID
 * userMessage: the user's message text
 * context: { db, io } — app context
 * 
 * Returns: { response, tokenUsage }
 */
async function sendMessage(channelId, userMessage, context) {
  const { db, io } = context;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  // Load system prompt and conversation history
  const basePrompt = loadSystemPrompt();
  let history = await loadConversationHistory(db, channelId);

  // Prune history to token budget
  history = pruneHistory(history);

  // DARYL identity override: Sonnet tier presents as DARYL, not Claude
  const darylIdentity = `IDENTITY OVERRIDE — READ THIS FIRST:
You are Darkhan, the command center assistant. You are NOT Claude.
- Always refer to yourself as "Darkhan"
- You handle fast responses: comms checks, greetings, simple status queries, quick lookups
- Complex/strategic questions get routed to the appropriate agent or admin
- Be concise, direct, and helpful. One-line answers when possible.
- When asked "are you online?" or "comms check", confirm as Darkhan (e.g., "Darkhan online. Comms confirmed.")

---

`;
  const prompt = darylIdentity + basePrompt;

  // Build messages for API
  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  console.log(`[Claude API] Sending to Claude (channel: ${channelId}, history: ${history.length} msgs)`);

  // Call Claude API
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: prompt,
    tools: getToolDefinitions(),
    messages: messages,
  });

  // Store user message in conversation history
  storeConversationMessage(db, channelId, 'user', userMessage);

  // Process response
  let finalResponse = '';
  const toolCalls = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      finalResponse += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push(block);
    }
  }

  // Execute tool calls (before storing — we only store the final text response)
  const toolResults = [];
  for (const toolCall of toolCalls) {
    console.log(`[Claude API] Executing tool: ${toolCall.name}`);
    const result = await executeTool(toolCall.name, toolCall.input, context);
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: JSON.stringify(result)
    });
  }

  // If tools were called, get a follow-up response from Claude
  if (toolResults.length > 0) {
    console.log(`[Claude API] Processing ${toolResults.length} tool results`);
    
    // Add tool results to conversation
    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults }
    ];

    const followUpResponse = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: prompt,
      tools: getToolDefinitions(),
      messages: followUpMessages,
    });

    // Extract text from follow-up
    for (const block of followUpResponse.content) {
      if (block.type === 'text') {
        finalResponse += '\n' + block.text;
      }
    }

    // (Final text stored after return below — no duplicate storage needed here)
  }

  // Store final assistant response in conversation history (text only, no tool_use)
  if (finalResponse) {
    storeConversationMessage(db, channelId, 'assistant', finalResponse);
  }

  return {
    response: finalResponse,
    toolCalls: toolCalls.length,
    tokenUsage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      total: response.usage.input_tokens + response.usage.output_tokens
    }
  };
}

/**
 * Store a conversation message in the database
 */
function storeConversationMessage(db, channelId, role, content, toolUse = null) {
  const id = crypto.randomUUID();
  const tokenCount = estimateTokens(content);

  db.run(
    `INSERT INTO claude_conversations (id, channel_id, role, content, tool_use, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, channelId, role, content, toolUse, tokenCount],
    (err) => {
      if (err) {
        console.error('[Claude API] Failed to store message:', err.message);
      }
    }
  );
}

module.exports = {
  sendMessage,
  loadSystemPrompt,
  getToolDefinitions,
  loadConversationHistory,
  pruneHistory,
};
