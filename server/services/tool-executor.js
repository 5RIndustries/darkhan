/**
 * Darkhan — Tool Executor
 * 
 * Executes tool calls from Claude's API responses.
 * Integrates with permissions, file I/O, and message bus.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkPermission, normalizePath } = require('./permissions');

/**
 * Execute a tool call from Claude
 * 
 * toolName: 'send_message' | 'create_task' | 'read_file' | 'write_file'
 * toolInput: { ... tool-specific params ... }
 * context: { db, io } — app context
 * 
 * Returns: { success: boolean, result?: any, error?: string }
 */
async function executeTool(toolName, toolInput, context) {
  console.log(`[Tool] Executing ${toolName}:`, JSON.stringify(toolInput).slice(0, 100));

  try {
    switch (toolName) {
      case 'send_message':
        return await sendMessage(toolInput, context);
      case 'create_task':
        return await createTask(toolInput, context);
      case 'read_file':
        return await readFile(toolInput, context);
      case 'write_file':
        return await writeFile(toolInput, context);
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`[Tool Error] ${toolName}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * send_message(channel_id, body)
 * Post a message to the Darkhan message bus
 */
async function sendMessage(input, context) {
  const { channel_id, body } = input;
  const { db, io } = context;

  if (!channel_id || !body) {
    return { success: false, error: 'channel_id and body are required' };
  }

  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const darkhanUserId = 'agent_darkhan';

    db.run(
      `INSERT INTO messages (id, channel_id, from_user, body, priority, type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channel_id, darkhanUserId, body, 'normal', 'message'],
      function (err) {
        if (err) {
          console.error('[send_message] DB error:', err.message);
          return resolve({ success: false, error: err.message });
        }

        const message = {
          id,
          channel_id,
          from_user: darkhanUserId,
          body,
          type: 'message',
          created_at: new Date().toISOString()
        };

        // Emit to WebSocket subscribers
        if (io) {
          io.to(channel_id).emit('new_message', message);
        }

        console.log(`[send_message] Posted to ${channel_id}`);
        resolve({ success: true, result: { message_id: id } });
      }
    );
  });
}

/**
 * create_task(title, description, assignee, priority)
 * Create a task in Darkhan
 */
async function createTask(input, context) {
  const { title, description, assignee, priority = 3 } = input;
  const { db } = context;

  if (!title || !assignee) {
    return { success: false, error: 'title and assignee are required' };
  }

  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const darkhanUserId = 'agent_darkhan';

    db.run(
      `INSERT INTO tasks (id, title, description, assignee, created_by, priority)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, description || '', assignee, darkhanUserId, priority],
      function (err) {
        if (err) {
          console.error('[create_task] DB error:', err.message);
          return resolve({ success: false, error: err.message });
        }

        console.log(`[create_task] Created task ${id}: ${title}`);
        resolve({ success: true, result: { task_id: id } });
      }
    );
  });
}

/**
 * read_file(path)
 * Read a file from the folio
 */
async function readFile(input, context) {
  const { path: folioPath } = input;

  if (!folioPath) {
    return { success: false, error: 'path is required' };
  }

  // Check permission
  const perm = checkPermission('file_read', folioPath);
  if (perm.status === 'denied') {
    return { success: false, error: `Permission denied: ${perm.reason}` };
  }

  // Read file
  try {
    const fullPath = normalizePath(folioPath);
    if (!fullPath) {
      return { success: false, error: 'Invalid path' };
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    console.log(`[read_file] Read ${folioPath} (${content.length} bytes)`);
    return { success: true, result: { content } };
  } catch (err) {
    console.error(`[read_file] Error reading ${folioPath}:`, err.message);
    return { success: false, error: `Failed to read file: ${err.message}` };
  }
}

/**
 * write_file(path, content)
 * Write a file to the folio
 * If outside allowlist, queue for approval; return "queued" status
 */
async function writeFile(input, context) {
  const { path: folioPath, content } = input;
  const { db } = context;

  if (!folioPath || content === undefined) {
    return { success: false, error: 'path and content are required' };
  }

  // Check permission
  const perm = checkPermission('file_write', folioPath);

  if (perm.status === 'denied') {
    return { success: false, error: `Permission denied: ${perm.reason}` };
  }

  if (perm.status === 'queued') {
    // Queue for approval
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const actionDetail = JSON.stringify({ path: folioPath, contentLength: content.length });

      db.run(
        `INSERT INTO approval_queue (id, requested_by, action_type, action_detail)
         VALUES (?, ?, ?, ?)`,
        [id, 'claude-agent', 'file_write', actionDetail],
        function (err) {
          if (err) {
            console.error('[write_file] Queue error:', err.message);
            return resolve({ success: false, error: err.message });
          }
          console.log(`[write_file] Queued for approval: ${folioPath} (id: ${id})`);
          resolve({
            success: true,
            queued: true,
            approval_id: id,
            message: `Write to ${folioPath} queued for admin approval`
          });
        }
      );
    });
  }

  // Allowed — write directly
  try {
    const fullPath = normalizePath(folioPath);
    if (!fullPath) {
      return { success: false, error: 'Invalid path' };
    }

    // Create parent directories if needed
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    fs.writeFileSync(fullPath, content, { mode: 0o644 });
    console.log(`[write_file] Wrote ${folioPath} (${content.length} bytes)`);
    return { success: true, result: { path: folioPath } };
  } catch (err) {
    console.error(`[write_file] Error writing ${folioPath}:`, err.message);
    return { success: false, error: `Failed to write file: ${err.message}` };
  }
}

module.exports = {
  executeTool,
  sendMessage,
  createTask,
  readFile,
  writeFile,
};
