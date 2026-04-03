#!/usr/bin/env node
/**
 * Darkhan — Worker Process (Child)
 *
 * This runs as a forked child process for each worker agent.
 * It loads the worker module, provides tool interfaces that communicate
 * back to the parent via IPC, and executes tasks on demand.
 *
 * The parent (WorkerRuntime) manages scheduling, lifecycle, and proxies
 * all Darkhan API calls. This process has no direct database, socket,
 * or network access (except for LLM calls which are proxied).
 *
 * IPC Protocol:
 *   Parent -> Child:
 *     { type: 'init', workerPath, agentId, agentConfig, onboardingBrief, onboardingPreamble, folioPath }
 *     { type: 'run_task', taskName, timeout }
 *     { type: 'run_listener', listenerName, channelId, fromUser, body, timeout }
 *     { type: 'shutdown' }
 *     { type: 'response', requestId, result?, error? }  -- response to a proxy request
 *
 *   Child -> Parent:
 *     { type: 'ready', tasks: [...], listeners: [...] }
 *     { type: 'task_complete', taskName, elapsed }
 *     { type: 'task_failed', taskName, error, elapsed }
 *     { type: 'log', level, message }
 *     { type: 'proxy_request', requestId, method, args }  -- darkhan.post, llm.complete, etc.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let workerModule = null;
let agentId = null;
let agentConfig = null;
let folioPath = null;
let identityPreamble = '';

// Request ID counter for IPC proxy calls
let nextRequestId = 0;
const pendingRequests = new Map(); // requestId -> { resolve, reject, timer }

// Tool rate limits (same as in-process version)
const toolLimits = {
  fsReads: 0, maxFsReads: 200,
  fsWrites: 0, maxFsWrites: 50,
  shellExecs: 0, maxShellExecs: 10,
  reset() { this.fsReads = 0; this.fsWrites = 0; this.shellExecs = 0; },
  checkFs(op) {
    if (op === 'read' && ++this.fsReads > this.maxFsReads)
      throw new Error(`Tool rate limit: max ${this.maxFsReads} file reads per task exceeded`);
    if (op === 'write' && ++this.fsWrites > this.maxFsWrites)
      throw new Error(`Tool rate limit: max ${this.maxFsWrites} file writes per task exceeded`);
  },
  checkShell() {
    if (++this.shellExecs > this.maxShellExecs)
      throw new Error(`Tool rate limit: max ${this.maxShellExecs} shell executions per task exceeded`);
  },
};

/**
 * Send a proxy request to the parent and wait for the response.
 */
function proxyCall(method, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const requestId = ++nextRequestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Proxy call ${method} timed out after ${timeout}ms`));
    }, timeout);

    pendingRequests.set(requestId, { resolve, reject, timer });
    process.send({ type: 'proxy_request', requestId, method, args });
  });
}

/**
 * Build the context interfaces that mirror the in-process version
 * but proxy everything through IPC to the parent.
 */
function buildContext() {
  return {
    llm: {
      async complete(opts) {
        // Prepend identity preamble to system messages
        if (opts.messages && identityPreamble) {
          const hasSystem = opts.messages.some(m => m.role === 'system');
          if (hasSystem) {
            opts.messages = opts.messages.map(m =>
              m.role === 'system' ? { ...m, content: identityPreamble + '\n\n' + m.content } : m
            );
          } else {
            opts.messages = [{ role: 'system', content: identityPreamble }, ...opts.messages];
          }
        }
        return proxyCall('llm.complete', [opts], 120000);
      },
      async classify(opts) {
        return proxyCall('llm.classify', [opts], 60000);
      },
    },

    darkhan: {
      async post(channelId, body, opts) {
        return proxyCall('darkhan.post', [channelId, body, opts]);
      },
      async alert(body) {
        return proxyCall('darkhan.post', ['chan_alerts', body]);
      },
      async getMessages(channelId, opts) {
        return proxyCall('darkhan.getMessages', [channelId, opts]);
      },
      async createTask(task) {
        return proxyCall('darkhan.createTask', [{ ...task, createdBy: agentId }]);
      },
      async ping(status) {
        return proxyCall('darkhan.ping', [status || 'active']);
      },
      async requestApproval(opts) {
        return proxyCall('darkhan.requestApproval', [agentId, opts.action, opts.detail]);
      },
      async flagThreat({ category, severity, description, evidence }) {
        return proxyCall('darkhan.flagThreat', [{ category, severity, description, evidence, agentId }]);
      },
    },

    tools: {
      _toolLimits: toolLimits,
      fs: {
        async read(filePath) {
          toolLimits.checkFs('read');
          // [C-1 FIX] Proxy through parent for injection scanning
          // Direct fs.read in child bypassed injection detection
          return proxyCall('tools.fs.read', [filePath]);
        },
        async write(filePath, data) {
          toolLimits.checkFs('write');
          // Write permission checking is done by the parent via proxy
          return proxyCall('tools.fs.write', [filePath, data]);
        },
        exists(filePath) {
          const fullPath = filePath.startsWith('/') ? filePath : path.join(folioPath, filePath);
          return fs.existsSync(fullPath);
        },
        async readdir(dirPath) {
          const fullPath = dirPath.startsWith('/') ? dirPath : path.join(folioPath, dirPath);
          return fs.promises.readdir(fullPath);
        },
      },
      shell: {
        async exec(command, opts = {}) {
          toolLimits.checkShell();
          // Shell execution is proxied to parent for security checking
          return proxyCall('tools.shell.exec', [command, opts], opts.timeout || 30000);
        },
      },
    },

    config: agentConfig,

    log: {
      info(msg, data) {
        process.send({ type: 'log', level: 'info', message: msg, data });
      },
      warn(msg, data) {
        process.send({ type: 'log', level: 'warn', message: msg, data });
      },
      error(msg, data) {
        process.send({ type: 'log', level: 'error', message: msg, data });
      },
    },
  };
}

// --- IPC Message Handler ---

process.on('message', async (msg) => {
  switch (msg.type) {
    case 'init': {
      try {
        agentId = msg.agentId;
        agentConfig = msg.agentConfig;
        folioPath = msg.folioPath;
        identityPreamble = msg.onboardingPreamble || '';

        // Load the worker module
        workerModule = require(msg.workerPath);

        const ctx = buildContext();

        // Call onLoad
        if (typeof workerModule.onLoad === 'function') {
          await workerModule.onLoad(ctx);
        }

        // Report ready with task and listener names
        const tasks = Object.keys(workerModule.tasks || {});
        const listeners = Object.keys(workerModule.listeners || {});
        process.send({ type: 'ready', tasks, listeners });
      } catch (e) {
        process.send({ type: 'init_failed', error: e.message });
      }
      break;
    }

    case 'run_task': {
      const { taskName, timeout } = msg;
      const taskDef = workerModule?.tasks?.[taskName];
      if (!taskDef || !taskDef.run) {
        process.send({ type: 'task_failed', taskName, error: `Task ${taskName} not found`, elapsed: 0 });
        break;
      }

      toolLimits.reset();
      const start = Date.now();

      // Set up timeout
      const timer = setTimeout(() => {
        process.send({ type: 'task_failed', taskName, error: 'Timeout', elapsed: Date.now() - start });
      }, timeout || 300000);

      try {
        const ctx = buildContext();
        await taskDef.run(ctx);
        clearTimeout(timer);
        process.send({ type: 'task_complete', taskName, elapsed: Date.now() - start });
      } catch (e) {
        clearTimeout(timer);
        process.send({ type: 'task_failed', taskName, error: e.message, elapsed: Date.now() - start });
      }
      break;
    }

    case 'run_listener': {
      const { listenerName, channelId, fromUser, body, timeout } = msg;
      const listenerDef = workerModule?.listeners?.[listenerName];
      if (!listenerDef || !listenerDef.run) break;

      const timer = setTimeout(() => {
        process.send({ type: 'log', level: 'warn', message: `Listener ${listenerName} timed out` });
      }, timeout || 60000);

      try {
        const ctx = buildContext();
        await listenerDef.run(ctx, { channelId, fromUser, body });
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        process.send({ type: 'log', level: 'error', message: `Listener ${listenerName} error: ${e.message}` });
      }
      break;
    }

    case 'response': {
      // Response to a proxy request
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      break;
    }

    case 'shutdown': {
      process.exit(0);
      break;
    }
  }
});

// Handle uncaught errors
process.on('uncaughtException', (e) => {
  process.send({ type: 'log', level: 'error', message: `Uncaught exception: ${e.message}` });
});

process.on('unhandledRejection', (e) => {
  process.send({ type: 'log', level: 'error', message: `Unhandled rejection: ${e?.message || e}` });
});

// Signal we're alive
process.send({ type: 'alive' });
