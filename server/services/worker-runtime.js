/**
 * Darkhan — Worker Runtime
 *
 * Loads worker modules, schedules their tasks via node-cron,
 * and provides each worker with the llm/darkhan/tools/config/log interfaces.
 *
 * Workers are independent — a crash in one does not affect others.
 * Tasks within a worker run sequentially; tasks across workers run in parallel.
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { OnboardingService } = require('./onboarding');
const { EvidenceService } = require('./evidence');
const { ClaimVerifierService } = require('./claim-verifier');
const { WorkerSandbox } = require('./sandbox');

class WorkerRuntime {
  constructor({ llmService, db, io, config, activityLog, costTracker, securityService }) {
    this.llmService = llmService;
    this.db = db;
    this.io = io;
    this.securityService = securityService;
    this.config = config;
    this.activityLog = activityLog;
    this.costTracker = costTracker;
    this.workers = new Map();     // id -> { module, cronJobs, running, lastRun, status, listeners, context }
    this.vaultPath = (config.vault?.path || '~/darkhan-vault').replace('~', process.env.HOME);

    // Agent onboarding service — generates verified briefs for every worker
    this.onboardingService = new OnboardingService({
      config,
      db,
      vaultPath: this.vaultPath,
    });

    // Evidence service — structured evidence-based reporting for all workers
    this.evidenceService = new EvidenceService({ activityLog });

    // Claim verifier — tags agent messages with evidence of whether claims check out
    this.claimVerifier = new ClaimVerifierService({
      vaultPath: this.vaultPath,
      db,
      activityLog,
    });

    // Worker sandbox — OS-level isolation and resource monitoring
    this.sandbox = new WorkerSandbox({ config, activityLog });

    // Listener registry: pattern -> [{ workerId, listenerName, handler, timeout }]
    this.messageListeners = [];
  }

  /**
   * Load all workers from the workers/ directory.
   * Uses forked process isolation when sandbox.processIsolation is enabled.
   */
  async loadAll() {
    const workersDir = path.join(__dirname, '..', 'workers');
    if (!fs.existsSync(workersDir)) {
      fs.mkdirSync(workersDir, { recursive: true });
      console.log('[WorkerRuntime] Created workers/ directory');
      return;
    }

    const files = fs.readdirSync(workersDir).filter(f => f.endsWith('.worker.js'));
    console.log(`[WorkerRuntime] Found ${files.length} worker(s): ${files.join(', ')}`);

    // [M-1 FIX] Use explicit DARKHAN_DEV_MODE, not NODE_ENV
    const useForked = this.config.sandbox?.processIsolation === true
      && process.env.DARKHAN_DEV_MODE !== 'true';

    if (useForked) {
      console.log('[WorkerRuntime] Process isolation ENABLED — workers will run as forked child processes');
    }

    for (const file of files) {
      try {
        if (useForked) {
          await this.loadWorkerForked(path.join(workersDir, file));
        } else {
          await this.loadWorker(path.join(workersDir, file));
        }
      } catch (e) {
        console.error(`[WorkerRuntime] Failed to load ${file}:`, e.message);
        this.activityLog.append({
          actor: 'system',
          action: 'worker_load_failed',
          target: file,
          details: JSON.stringify({ error: e.message }),
        });
      }
    }
  }

  /**
   * Load a single worker module.
   * [ASI04] Verifies worker file hash against manifest before loading.
   */
  async loadWorker(filePath) {
    // [ASI04 SUPPLY CHAIN] Verify worker integrity before require()
    const crypto = require('crypto');
    const workerHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const manifestPath = path.join(__dirname, '..', 'workers', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const fileName = path.basename(filePath);
        if (manifest[fileName] && manifest[fileName] !== workerHash) {
          const msg = `Worker ${fileName} hash mismatch — expected ${manifest[fileName].substring(0, 16)}..., got ${workerHash.substring(0, 16)}...`;
          console.error(`[WorkerRuntime] SUPPLY CHAIN ALERT: ${msg}`);
          this.activityLog.append({
            actor: 'worker_runtime',
            action: 'worker_hash_mismatch',
            target: fileName,
            details: JSON.stringify({ expected: manifest[fileName], actual: workerHash }),
          });
          // In production, block the load. In dev mode, warn and continue.
          // [M-1 FIX] Use explicit DARKHAN_DEV_MODE, not NODE_ENV
          if (!this.sandbox.devMode && process.env.DARKHAN_DEV_MODE !== 'true') {
            throw new Error(`SUPPLY CHAIN: ${msg}`);
          }
          console.warn(`[WorkerRuntime] DEV MODE: Loading worker despite hash mismatch`);
        }
      } catch (e) {
        if (e.message.startsWith('SUPPLY CHAIN')) throw e;
        // Manifest parse error — log but don't block
        console.warn(`[WorkerRuntime] Could not verify worker manifest: ${e.message}`);
      }
    }

    const workerModule = require(filePath);
    const { id, name, tasks, onLoad } = workerModule;

    if (!id || !tasks) {
      throw new Error(`Worker ${filePath} missing required 'id' or 'tasks'`);
    }

    // Find agent config
    const agentConfig = this.config.team.members.find(m => m.id === id);
    if (!agentConfig) {
      throw new Error(`Worker ${id} not found in darkhan.config.json team members`);
    }

    // [SANDBOX] Log sandbox configuration for this worker
    if (this.sandbox.enabled) {
      const sandboxEnv = this.sandbox.buildEnvironment(agentConfig);
      const limits = this.sandbox.getLimits(agentConfig);
      const paths = this.sandbox.getAllowedPaths(agentConfig);
      console.log(`[Sandbox] ${id}: env=${Object.keys(sandboxEnv).length} vars, ` +
        `mem=${limits.maxMemoryMB}MB, write=${paths.write.length} path(s), ` +
        `deny=${paths.deny.length} path(s)`);

      // Generate sandbox profile (macOS only, for future subprocess mode)
      const profile = this.sandbox.generateSandboxProfile(id, agentConfig);
      if (profile) {
        this.sandbox.writeSandboxProfile(id, profile);
      }

      // Register for resource monitoring
      this.sandbox.processes.set(id, {
        proc: process, // Current process for now — future: child process
        limits,
        allowedPaths: paths,
        env: sandboxEnv,
      });
    }

    // Build the context object provided to all tasks (async — generates onboarding brief)
    const context = await this._buildContext(id, agentConfig);

    // Call onLoad if defined
    if (typeof onLoad === 'function') {
      try {
        await onLoad(context);
      } catch (e) {
        console.error(`[WorkerRuntime] ${id} onLoad failed:`, e.message);
      }
    }

    // Schedule tasks
    const cronJobs = [];
    const runOnLoadQueue = [];
    for (const [taskName, taskDef] of Object.entries(tasks)) {
      const { schedule, timeout = 300000, retryOnFail = false, runOnLoad = false } = taskDef;

      if (!schedule || !cron.validate(schedule)) {
        console.error(`[WorkerRuntime] ${id}.${taskName}: invalid cron schedule "${schedule}"`);
        continue;
      }

      const job = cron.schedule(schedule, () => {
        this._executeTask(id, taskName, taskDef, context, timeout, retryOnFail);
      }, {
        timezone: this.config.instance?.timezone || 'America/New_York',
      });

      cronJobs.push({ taskName, job, schedule });
      console.log(`[WorkerRuntime] ${id}.${taskName} scheduled: ${schedule}`);

      // Queue for sequential execution on load
      if (runOnLoad) {
        console.log(`[WorkerRuntime] ${id}.${taskName} queued for run-on-load`);
        runOnLoadQueue.push({ taskName, taskDef, timeout, retryOnFail });
      }
    }

    // Run queued on-load tasks sequentially (not in parallel)
    if (runOnLoadQueue.length > 0) {
      setImmediate(async () => {
        for (const { taskName, taskDef, timeout: to, retryOnFail: retry } of runOnLoadQueue) {
          console.log(`[WorkerRuntime] ${id}.${taskName} running on load`);
          await this._executeTask(id, taskName, taskDef, context, to, retry);
        }
      });
    }

    // Register message listeners (event-driven tasks)
    const listeners = workerModule.listeners || {};
    for (const [listenerName, listenerDef] of Object.entries(listeners)) {
      const { patterns = [], timeout = 60000 } = listenerDef;
      const compiledPatterns = patterns.map(p =>
        p instanceof RegExp ? p : new RegExp(p, 'i')
      );

      this.messageListeners.push({
        workerId: id,
        listenerName,
        patterns: compiledPatterns,
        handler: listenerDef.run,
        timeout,
        context,
      });

      console.log(`[WorkerRuntime] ${id}.${listenerName} listening for ${patterns.length} pattern(s)`);
    }

    this.workers.set(id, {
      module: workerModule,
      cronJobs,
      running: null,
      lastRun: null,
      status: 'idle',
      name: name || id,
      context,
    });

    this.activityLog.append({
      actor: id,
      action: 'worker_loaded',
      target: path.basename(filePath),
      details: JSON.stringify({ tasks: Object.keys(tasks), schedules: cronJobs.map(j => j.schedule) }),
    });

    console.log(`[WorkerRuntime] ${id} loaded (${cronJobs.length} task(s))`);
  }

  /**
   * [P0-1] Load a worker as a forked child process with OS-level isolation.
   * The child runs worker-process.js and communicates via IPC.
   * Cron scheduling and Darkhan API proxying happen in the parent.
   */
  async loadWorkerForked(filePath) {
    const { fork } = require('child_process');
    const self = this;

    // Supply chain verification (same as in-process)
    const crypto = require('crypto');
    const workerHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const manifestPath = path.join(__dirname, '..', 'workers', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const fileName = path.basename(filePath);
        if (manifest[fileName] && manifest[fileName] !== workerHash) {
          throw new Error(`SUPPLY CHAIN: Worker ${fileName} hash mismatch`);
        }
      } catch (e) {
        if (e.message.startsWith('SUPPLY CHAIN')) throw e;
      }
    }

    // Peek at the worker module to get its ID (needed for config lookup)
    const workerModule = require(filePath);
    const { id, name, tasks, listeners: listenerDefs } = workerModule;
    delete require.cache[require.resolve(filePath)]; // Unload — child will load it

    if (!id || !tasks) {
      throw new Error(`Worker ${filePath} missing required 'id' or 'tasks'`);
    }

    const agentConfig = this.config.team.members.find(m => m.id === id);
    if (!agentConfig) {
      throw new Error(`Worker ${id} not found in darkhan.config.json team members`);
    }

    // Generate onboarding brief for the child
    let onboarding = { preamble: '', full: '' };
    try {
      onboarding = await this.onboardingService.generateBrief(id, agentConfig);
    } catch (e) {
      console.error(`[WorkerRuntime] ${id} onboarding failed:`, e.message);
    }

    // Build sandboxed environment
    const sandboxEnv = this.sandbox.buildEnvironment(agentConfig);

    // Fork the child process
    const childPath = path.join(__dirname, 'worker-process.js');
    const child = fork(childPath, [], {
      env: sandboxEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: path.join(__dirname, '..'),
    });

    console.log(`[WorkerRuntime] ${id} forked as PID ${child.pid}`);

    // Handle child logs
    child.stdout?.on('data', (data) => console.log(`[${id}] ${data.toString().trim()}`));
    child.stderr?.on('data', (data) => console.error(`[${id}] ${data.toString().trim()}`));

    // Wait for ready signal
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${id} init timeout`)), 30000);

      child.on('message', function onMsg(msg) {
        if (msg.type === 'alive') {
          // Send init
          child.send({
            type: 'init',
            workerPath: filePath,
            agentId: id,
            agentConfig,
            onboardingPreamble: onboarding.preamble,
            vaultPath: self.vaultPath,
          });
        } else if (msg.type === 'ready') {
          clearTimeout(timeout);
          child.removeListener('message', onMsg);
          resolve(msg);
        } else if (msg.type === 'init_failed') {
          clearTimeout(timeout);
          child.removeListener('message', onMsg);
          reject(new Error(msg.error));
        }
      });

      child.on('error', (e) => { clearTimeout(timeout); reject(e); });
      child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Child exited with code ${code}`)); });
    });

    // Set up IPC proxy handler for Darkhan API calls from the child
    child.on('message', async (msg) => {
      if (msg.type === 'proxy_request') {
        try {
          const result = await self._handleProxyRequest(id, msg.method, msg.args, agentConfig);
          child.send({ type: 'response', requestId: msg.requestId, result });
        } catch (e) {
          child.send({ type: 'response', requestId: msg.requestId, error: e.message });
        }
      } else if (msg.type === 'log') {
        const prefix = `[${id}]`;
        if (msg.level === 'error') {
          console.error(prefix, msg.message);
          this._postToChannel('chan_alerts', `[${id}] ERROR: ${msg.message}`, id);
        } else if (msg.level === 'warn') {
          console.warn(prefix, msg.message);
        } else {
          console.log(prefix, msg.message);
        }
        self.activityLog.append({ actor: id, action: 'log_' + msg.level, details: msg.message });
      } else if (msg.type === 'task_complete') {
        const worker = self.workers.get(id);
        if (worker) { worker.running = null; worker.status = 'idle'; worker.lastRun = new Date().toISOString(); }
        self.activityLog.append({ actor: id, action: 'task_completed', target: msg.taskName, details: JSON.stringify({ elapsedMs: msg.elapsed }) });
        self._pingHealth(id, 'active');
        console.log(`[WorkerRuntime] ${id}.${msg.taskName} COMPLETED (${msg.elapsed}ms)`);
      } else if (msg.type === 'task_failed') {
        const worker = self.workers.get(id);
        if (worker) { worker.running = null; worker.status = 'error'; }
        self.activityLog.append({ actor: id, action: 'task_failed', target: msg.taskName, details: JSON.stringify({ error: msg.error, elapsedMs: msg.elapsed }) });
        console.error(`[WorkerRuntime] ${id}.${msg.taskName} FAILED (${msg.elapsed}ms): ${msg.error}`);
      }
    });

    // Handle child exit
    child.on('exit', (code) => {
      console.error(`[WorkerRuntime] ${id} child process exited (code ${code})`);
      self.activityLog.append({ actor: id, action: 'worker_process_exited', details: JSON.stringify({ code }) });
      const worker = self.workers.get(id);
      if (worker) worker.status = 'dead';
    });

    // Schedule cron tasks (in parent — send run_task to child when cron fires)
    const cronJobs = [];
    for (const [taskName, taskDef] of Object.entries(tasks)) {
      const { schedule, timeout = 300000, runOnLoad = false } = taskDef;
      if (!schedule || !cron.validate(schedule)) continue;

      const job = cron.schedule(schedule, () => {
        const worker = self.workers.get(id);
        if (!worker || worker.disabled || worker.running) return;
        worker.running = taskName;
        worker.status = 'busy';
        child.send({ type: 'run_task', taskName, timeout });
      }, { timezone: self.config.instance?.timezone || 'America/New_York' });

      cronJobs.push({ taskName, job, schedule });
      console.log(`[WorkerRuntime] ${id}.${taskName} scheduled (forked): ${schedule}`);

      if (runOnLoad) {
        setImmediate(() => {
          const worker = self.workers.get(id);
          if (worker) { worker.running = taskName; worker.status = 'busy'; }
          child.send({ type: 'run_task', taskName, timeout });
        });
      }
    }

    // Register listeners (matching happens in parent, execution sent to child)
    for (const [listenerName, listenerDef] of Object.entries(listenerDefs || {})) {
      const { patterns = [], timeout = 60000 } = listenerDef;
      const compiledPatterns = patterns.map(p => p instanceof RegExp ? p : new RegExp(p, 'i'));

      this.messageListeners.push({
        workerId: id,
        listenerName,
        patterns: compiledPatterns,
        handler: async (ctx, { channelId, fromUser, body }) => {
          child.send({ type: 'run_listener', listenerName, channelId, fromUser, body, timeout });
        },
        timeout,
        context: null, // Not needed — child has its own context
      });
    }

    // Register worker
    this.workers.set(id, {
      module: null, // Not loaded in parent
      childProcess: child,
      cronJobs,
      running: null,
      lastRun: null,
      status: 'idle',
      name: name || id,
      context: null,
      forked: true,
    });

    // Register for sandbox monitoring
    this.sandbox.processes.set(id, {
      proc: child,
      limits: this.sandbox.getLimits(agentConfig),
      allowedPaths: this.sandbox.getAllowedPaths(agentConfig),
      env: sandboxEnv,
    });

    // Start resource watchdog
    this.sandbox.startWatchdog(id, child, this.sandbox.getLimits(agentConfig));

    this.activityLog.append({
      actor: id,
      action: 'worker_loaded_forked',
      target: path.basename(filePath),
      details: JSON.stringify({ pid: child.pid, tasks: Object.keys(tasks) }),
    });

    console.log(`[WorkerRuntime] ${id} loaded (forked, PID ${child.pid}, ${cronJobs.length} task(s))`);
  }

  /**
   * Handle a proxy request from a forked child process.
   * Routes the request to the appropriate service and returns the result.
   */
  async _handleProxyRequest(agentId, method, args, agentConfig) {
    switch (method) {
      case 'llm.complete':
        return this.llmService.complete({ agentId, ...args[0] });
      case 'llm.classify':
        return this.llmService.classify ? this.llmService.classify({ agentId, ...args[0] }) : null;
      case 'darkhan.post':
        return this._postToChannel(args[0], args[1], agentId, args[2] || {});
      case 'darkhan.getMessages':
        return this._getMessages(args[0], args[1] || {});
      case 'darkhan.createTask':
        return this._createTask(args[0]);
      case 'darkhan.ping':
        return this._pingHealth(agentId, args[0] || 'active');
      case 'darkhan.requestApproval':
        return this._requestApproval(args[0], args[1], args[2]);
      case 'darkhan.flagThreat': {
        const { category, severity, description, evidence } = args[0];
        const crypto = require('crypto');
        const sig = crypto.createHash('sha256').update(`${category}|${description}|${agentId}`).digest('hex');
        const alertBody = `**[THREAT FLAG]** ${severity?.toUpperCase() || 'UNKNOWN'}\n**From:** ${agentId}\n**Category:** ${category}\n**Description:** ${description}${evidence ? `\n**Evidence:** ${evidence}` : ''}`;
        await this._postToChannel('chan_alerts', alertBody, agentId);
        if (this.activityLog?.appendSpacer) {
          this.activityLog.appendSpacer({ category: category || 'anomaly', signature: sig, description: `[${agentId}] ${severity}: ${description}` });
        }
        return { ok: true };
      }
      case 'tools.fs.read': {
        const filePath = args[0];
        const fullPath = filePath.startsWith('/') ? filePath : path.join(this.vaultPath, filePath);
        // Sandbox deny-list check
        if (this.sandbox.enabled) {
          const denyPaths = this.sandbox.getAllowedPaths(agentConfig).deny;
          for (const denied of denyPaths) {
            if (fullPath.startsWith(denied)) throw new Error(`Sandbox: read denied for ${filePath}`);
          }
        }
        const content = await fs.promises.readFile(fullPath, 'utf8');
        // [C-1 FIX] Injection scan on file content before returning to child
        if (this.securityService && content.length > 0) {
          const scan = this.securityService.scanForInjection(content, { source: `file:${filePath}`, origin: 'vault' });
          if (!scan.safe && scan.severity === 'critical') {
            this.activityLog?.append({ actor: agentId, action: 'tool_output_injection_detected', target: filePath, details: JSON.stringify({ severity: scan.severity }) });
            throw new Error(`ASI01: File ${filePath} contains critical injection patterns — read blocked`);
          }
        }
        return content;
      }
      case 'tools.fs.write': {
        const filePath = args[0];
        const data = args[1];
        const fullPath = filePath.startsWith('/') ? filePath : path.join(this.vaultPath, filePath);
        // Check write permissions
        const allowed = agentConfig.permissions?.fsWrite || [];
        const relPath = path.relative(this.vaultPath, fullPath);
        const permitted = allowed.length > 0 && allowed.some(prefix => relPath.startsWith(prefix));
        if (!permitted) throw new Error(`Write permission denied: ${relPath}`);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await fs.promises.writeFile(fullPath, data, 'utf8');
        return { ok: true };
      }
      case 'tools.shell.exec': {
        const command = args[0];
        const opts = args[1] || {};
        // Security check
        if (this.securityService) {
          const check = this.securityService.checkShellCommand(agentId, command);
          if (!check.allowed) throw new Error(`Security: ${check.reason}`);
        }
        const { execFile } = require('child_process');
        return new Promise((resolve, reject) => {
          execFile('/bin/sh', ['-c', command], {
            cwd: opts.cwd || this.vaultPath,
            timeout: opts.timeout || 30000,
            env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', USER: process.env.USER, TERM: process.env.TERM || 'xterm-256color' },
          }, (err, stdout, stderr) => {
            if (err) reject(new Error(`Shell error: ${err.message}`));
            else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          });
        });
      }
      default:
        throw new Error(`Unknown proxy method: ${method}`);
    }
  }

  /**
   * Execute a single task with error isolation.
   */
  async _executeTask(workerId, taskName, taskDef, context, timeout, retryOnFail) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Skip if worker is disabled
    if (worker.disabled) {
      console.log(`[WorkerRuntime] ${workerId}.${taskName} SKIPPED (worker disabled)`);
      return;
    }

    // Skip if worker is already running a task (sequential execution)
    if (worker.running) {
      console.log(`[WorkerRuntime] ${workerId}.${taskName} SKIPPED (${worker.running} still running)`);
      this.activityLog.append({
        actor: workerId,
        action: 'task_skipped',
        target: taskName,
        details: JSON.stringify({ reason: `${worker.running} still running` }),
      });
      return;
    }

    worker.running = taskName;
    worker.status = 'busy';
    const startTime = Date.now();

    // [ASI02] Reset tool rate limits for this task execution
    if (context.tools?._toolLimits) context.tools._toolLimits.reset();

    console.log(`[WorkerRuntime] ${workerId}.${taskName} STARTED`);
    this.activityLog.append({
      actor: workerId,
      action: 'task_started',
      target: taskName,
    });

    // Ping health
    this._pingHealth(workerId, 'busy');

    try {
      // Run with timeout
      await Promise.race([
        taskDef.run(context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Task timeout after ${timeout}ms`)), timeout)
        ),
      ]);

      const elapsed = Date.now() - startTime;
      worker.lastRun = { task: taskName, at: new Date().toISOString(), elapsed, status: 'success' };
      console.log(`[WorkerRuntime] ${workerId}.${taskName} COMPLETED (${elapsed}ms)`);

      this.activityLog.append({
        actor: workerId,
        action: 'task_completed',
        target: taskName,
        details: JSON.stringify({ elapsedMs: elapsed }),
      });

    } catch (e) {
      const elapsed = Date.now() - startTime;
      worker.lastRun = { task: taskName, at: new Date().toISOString(), elapsed, status: 'failed', error: e.message };
      console.error(`[WorkerRuntime] ${workerId}.${taskName} FAILED (${elapsed}ms):`, e.message);

      this.activityLog.append({
        actor: workerId,
        action: 'task_failed',
        target: taskName,
        details: JSON.stringify({ elapsedMs: elapsed, error: e.message }),
      });

      // Post to alerts
      this._postToChannel('chan_alerts', `[${workerId}] Task ${taskName} failed: ${e.message}`, workerId);

      // Retry if configured
      if (retryOnFail) {
        console.log(`[WorkerRuntime] ${workerId}.${taskName} retrying in 60s`);
        setTimeout(() => {
          worker.running = null;
          this._executeTask(workerId, taskName, taskDef, context, timeout, false);
        }, 60000);
        return;
      }
    } finally {
      worker.running = null;
      worker.status = 'idle';
      this._pingHealth(workerId, 'active');
    }
  }

  /**
   * Build the context object that every worker task receives.
   * Now async — generates an onboarding brief and injects the identity
   * preamble into every LLM call automatically.
   */
  async _buildContext(agentId, agentConfig) {
    const self = this;

    // [ASI02] Tool rate limiter — caps per-task tool invocations.
    // Reset at the start of each task execution.
    const toolLimits = {
      fsReads: 0, maxFsReads: 200,
      fsWrites: 0, maxFsWrites: 50,
      shellExecs: 0, maxShellExecs: 10,
      reset() { this.fsReads = 0; this.fsWrites = 0; this.shellExecs = 0; },
      checkFs(op) {
        if (op === 'read' && ++this.fsReads > this.maxFsReads) {
          throw new Error(`Tool rate limit: max ${this.maxFsReads} file reads per task exceeded`);
        }
        if (op === 'write' && ++this.fsWrites > this.maxFsWrites) {
          throw new Error(`Tool rate limit: max ${this.maxFsWrites} file writes per task exceeded`);
        }
      },
      checkShell() {
        if (++this.shellExecs > this.maxShellExecs) {
          throw new Error(`Tool rate limit: max ${this.maxShellExecs} shell executions per task exceeded`);
        }
      },
    };

    // Generate the onboarding brief from verified system state
    let onboarding = null;
    try {
      onboarding = await this.onboardingService.generateBrief(agentId, agentConfig);
      console.log(`[WorkerRuntime] ${agentId} onboarding brief generated (${onboarding.full.length} chars)`);
    } catch (e) {
      console.error(`[WorkerRuntime] ${agentId} onboarding generation failed: ${e.message}`);
      // Fallback: minimal preamble so agents still know who they are
      onboarding = {
        full: `[Onboarding brief generation failed: ${e.message}]`,
        preamble: `You are ${agentConfig.name}, an agent for ${this.config.instance?.name || 'Darkhan'}. Onboarding brief generation failed. RULES: Never claim unverified state. Never fabricate information. Flag all assumptions. If you don't know, say so.`,
        sections: {},
      };
    }

    // The preamble that gets prepended to every LLM system message
    const identityPreamble = onboarding.preamble;

    return {
      // Onboarding brief — workers can access the full brief or individual sections
      onboarding,

      // Evidence service — structured evidence-based reporting
      evidence: self.evidenceService,

      // LLM interface (rate-limited, cost-tracked, security-validated)
      // The identity preamble is automatically prepended to every system message.
      llm: {
        async complete(opts) {
          // Clone messages to avoid mutating the caller's array
          const messages = [...(opts.messages || [])];

          // Inject identity preamble into the system message
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `[IDENTITY] ${identityPreamble}\n\n${messages[0].content}`,
            };
          } else {
            // No system message provided — add one with just the preamble
            messages.unshift({
              role: 'system',
              content: `[IDENTITY] ${identityPreamble}`,
            });
          }

          const result = await self.llmService.complete({
            agentId,
            provider: opts.provider || agentConfig.model?.provider,
            model: opts.model || agentConfig.model?.model,
            messages,
            options: opts.options || {},
            requestType: opts.requestType || 'task',
          });

          // Security: validate LLM output if validation rules provided
          if (opts.validation && self.securityService) {
            const check = self.securityService.validateLLMOutput(result.response, opts.validation);
            if (!check.valid) {
              self.activityLog.append({
                actor: agentId,
                action: 'llm_output_validation_failed',
                details: JSON.stringify({ reason: check.reason }),
              });
              result.response = check.output;
              result.validationFailed = true;
              result.validationReason = check.reason;
            }
          }

          // Security: always scan output for sensitive data leakage
          if (self.securityService) {
            const leakCheck = self.securityService.scanForLeakage(result.response);
            if (!leakCheck.safe) {
              result.response = '[REDACTED — output contained sensitive data]';
              result.redacted = true;
            }
          }

          return result;
        },
        async classify(opts) {
          return self.llmService.classify({
            agentId,
            text: opts.text,
            categories: opts.categories,
            provider: opts.provider,
            model: opts.model,
            requestType: opts.requestType || 'triage',
          });
        },
      },

      // Darkhan command center interface
      darkhan: {
        post: (channelId, body, opts) => self._postToChannel(channelId, body, agentId, opts),
        alert: (body) => self._postToChannel('chan_alerts', body, agentId),
        getMessages: (channelId, opts) => self._getMessages(channelId, opts),
        createTask: (task) => self._createTask({ ...task, createdBy: agentId }),
        ping: (status) => self._pingHealth(agentId, status || 'active'),
        /**
         * Request approval for a sensitive action.
         * @param {Object} opts - { action: string, detail: string }
         * @returns {Promise<Object>} The created approval record
         */
        requestApproval: ({ action, detail }) => self._requestApproval(agentId, action, detail),
        /**
         * Flag a threat or concern. Posts a structured alert to chan_alerts
         * and creates a CRISPR defense spacer in the hash chain.
         * Any worker can call this — it's the "pull the alarm" capability.
         *
         * @param {Object} opts
         * @param {string} opts.category - 'injection', 'impersonation', 'exfiltration', 'escalation', 'anomaly', 'integrity'
         * @param {string} opts.severity - 'low', 'medium', 'high', 'critical'
         * @param {string} opts.description - What was detected
         * @param {string} [opts.evidence] - Supporting evidence (optional)
         */
        flagThreat: async ({ category, severity, description, evidence }) => {
          const crypto = require('crypto');
          const sig = crypto.createHash('sha256').update(`${category}|${description}|${agentId}`).digest('hex');

          // Post structured alert
          const alertBody = `**[THREAT FLAG]** ${severity?.toUpperCase() || 'UNKNOWN'}\n` +
            `**From:** ${agentId}\n` +
            `**Category:** ${category}\n` +
            `**Description:** ${description}` +
            (evidence ? `\n**Evidence:** ${evidence}` : '');
          await self._postToChannel('chan_alerts', alertBody, agentId);

          // Create CRISPR spacer
          if (self.activityLog?.appendSpacer) {
            self.activityLog.appendSpacer({
              category: category || 'anomaly',
              signature: sig,
              description: `[${agentId}] ${severity}: ${description}`,
            });
          }

          // Log to activity trail
          if (self.activityLog) {
            self.activityLog.append({
              actor: agentId,
              action: 'threat_flagged',
              target: category,
              details: JSON.stringify({ severity, description, evidence, signature: sig }),
            });
          }
        },
      },

      // File system tools (scoped to permissions)
      tools: {
        _toolLimits: toolLimits, // Exposed for per-task reset by _executeTask
        fs: {
          read: async (filePath) => {
            toolLimits.checkFs('read');
            const fullPath = filePath.startsWith('/') ? filePath : path.join(self.vaultPath, filePath);
            // [SANDBOX] Check deny list for reads
            if (self.sandbox.enabled) {
              const denyPaths = self.sandbox.getAllowedPaths(agentConfig).deny;
              for (const denied of denyPaths) {
                if (fullPath.startsWith(denied)) {
                  throw new Error(`Sandbox: read denied for ${filePath} (protected path)`);
                }
              }
            }
            const content = await fs.promises.readFile(fullPath, 'utf8');
            // [ASI01] Scan file content for injection before it reaches LLM context.
            // This catches indirect injection via vault files containing payloads.
            if (self.securityService && content.length > 0) {
              const scan = self.securityService.scanForInjection(content, {
                source: `file:${filePath}`,
                origin: 'vault',
              });
              if (!scan.safe) {
                self.activityLog?.append({
                  actor: agentId,
                  action: 'tool_output_injection_detected',
                  target: filePath,
                  details: JSON.stringify({ severity: scan.severity, threats: scan.threats.length }),
                });
                if (scan.severity === 'critical') {
                  throw new Error(`ASI01: File ${filePath} contains critical injection patterns — read blocked`);
                }
                // Non-critical: log warning but return content (may be false positive)
                console.warn(`[ASI01] ${agentId} read file with injection patterns: ${filePath} (${scan.severity})`);
              }
            }
            return content;
          },
          write: (filePath, data) => {
            toolLimits.checkFs('write');
            const fullPath = filePath.startsWith('/') ? filePath : path.join(self.vaultPath, filePath);
            // [SANDBOX] Check deny list for writes
            if (self.sandbox.enabled) {
              const denyPaths = self.sandbox.getAllowedPaths(agentConfig).deny;
              for (const denied of denyPaths) {
                if (fullPath.startsWith(denied)) {
                  throw new Error(`Sandbox: write denied for ${filePath} (protected path)`);
                }
              }
            }
            // Check write permissions
            const allowed = agentConfig.permissions?.fsWrite || [];
            const relPath = path.relative(self.vaultPath, fullPath);
            // SECURITY: Empty allowed array = NO write permissions (principle of least privilege).
            // Workers must have explicit fsWrite paths configured to write anything.
            const permitted = allowed.length > 0 && allowed.some(prefix => relPath.startsWith(prefix));
            if (!permitted) {
              throw new Error(`Write permission denied: ${relPath} (allowed: ${allowed.join(', ')})`);
            }
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            return fs.promises.writeFile(fullPath, data, 'utf8');
          },
          exists: (filePath) => {
            const fullPath = filePath.startsWith('/') ? filePath : path.join(self.vaultPath, filePath);
            return fs.existsSync(fullPath);
          },
          readdir: (dirPath) => {
            const fullPath = dirPath.startsWith('/') ? dirPath : path.join(self.vaultPath, dirPath);
            return fs.promises.readdir(fullPath);
          },
        },
        shell: {
          async exec(command, opts = {}) {
            toolLimits.checkShell();
            // Security: check shell permissions before execution
            if (self.securityService) {
              const check = self.securityService.checkShellCommand(agentId, command);
              if (!check.allowed) {
                throw new Error(`Security: ${check.reason}`);
              }
            }

            const { execFile } = require('child_process');
            const timeout = opts.timeout || 30000;
            return new Promise((resolve, reject) => {
              execFile('/bin/sh', ['-c', command], {
                cwd: opts.cwd || self.vaultPath,
                timeout,
                // SECURITY: Whitelist env vars — workers must NOT access SESSION_SECRET,
              // GOOGLE_API_KEY, ANTHROPIC_API_KEY, or any other secrets via printenv/env
              env: {
                HOME: process.env.HOME,
                PATH: process.env.PATH,
                LANG: process.env.LANG || 'en_US.UTF-8',
                USER: process.env.USER,
                TERM: process.env.TERM || 'xterm-256color',
              },
              }, (err, stdout, stderr) => {
                if (err) reject(new Error(`Shell error: ${err.message}`));
                const result = { stdout: stdout.trim(), stderr: stderr.trim() };
                // [ASI01] Scan shell output for injection before it reaches LLM context
                if (self.securityService && result.stdout.length > 0) {
                  const scan = self.securityService.scanForInjection(result.stdout, {
                    source: `shell:${command.substring(0, 50)}`,
                    origin: 'local',
                  });
                  if (!scan.safe && scan.severity === 'critical') {
                    self.activityLog?.append({
                      actor: agentId,
                      action: 'tool_output_injection_detected',
                      target: 'shell',
                      details: JSON.stringify({ command: command.substring(0, 100), severity: scan.severity }),
                    });
                    reject(new Error(`ASI01: Shell output contains critical injection patterns — blocked`));
                    return;
                  }
                }
                resolve(result);
              });
            });
          },
        },

        /**
         * Web tools — search and fetch external URLs.
         * Agents can research topics and retrieve web content.
         * Respects sandbox network egress rules.
         */
        web: {
          /**
           * Search the web using Google Custom Search API.
           * Requires GOOGLE_API_KEY and GOOGLE_SEARCH_CX in .env.
           * Falls back to a simple fetch-based search if not configured.
           */
          async search(query, opts = {}) {
            toolLimits.checkFs('read'); // Count against read limits
            const maxResults = opts.maxResults || 5;

            self.activityLog?.append({
              actor: agentId,
              action: 'web_search',
              target: query.substring(0, 100),
              details: JSON.stringify({ maxResults }),
            });

            // Use Google Custom Search if configured
            const googleKey = process.env.GOOGLE_API_KEY;
            const searchCx = process.env.GOOGLE_SEARCH_CX;

            if (googleKey && searchCx) {
              const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(searchCx)}&q=${encodeURIComponent(query)}&num=${maxResults}`;
              const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
              if (!resp.ok) throw new Error(`Search API error: ${resp.status}`);
              const data = await resp.json();
              return (data.items || []).map(item => ({
                title: item.title,
                url: item.link,
                snippet: item.snippet,
              }));
            }

            // Fallback: use the LLM's knowledge (no external search configured)
            return [{ title: 'No search API configured', url: '', snippet: 'Set GOOGLE_API_KEY and GOOGLE_SEARCH_CX in .env to enable web search. Falling back to LLM knowledge.' }];
          },

          /**
           * Fetch a URL and return its text content.
           * Respects timeout and size limits.
           */
          async fetch(url, opts = {}) {
            toolLimits.checkFs('read'); // Count against read limits
            const timeout = opts.timeout || 15000;
            const maxSize = opts.maxSize || 100000; // 100KB default

            // Basic URL validation
            let parsed;
            try {
              parsed = new URL(url);
            } catch {
              throw new Error(`Invalid URL: ${url}`);
            }

            // Security: only allow http/https
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              throw new Error(`Blocked protocol: ${parsed.protocol}`);
            }

            self.activityLog?.append({
              actor: agentId,
              action: 'web_fetch',
              target: url.substring(0, 200),
            });

            const resp = await fetch(url, {
              signal: AbortSignal.timeout(timeout),
              headers: { 'User-Agent': 'Darkhan/1.0 (research agent)' },
            });

            if (!resp.ok) throw new Error(`Fetch error: ${resp.status} ${resp.statusText}`);

            const text = await resp.text();

            // Truncate to max size
            const result = text.length > maxSize ? text.substring(0, maxSize) + '\n[TRUNCATED]' : text;

            // [ASI01] Scan fetched content for injection
            if (self.securityService && result.length > 0) {
              const scan = self.securityService.scanForInjection(result, {
                source: `web:${url.substring(0, 100)}`,
                origin: 'external',
              });
              if (!scan.safe && scan.severity === 'critical') {
                self.activityLog?.append({
                  actor: agentId,
                  action: 'tool_output_injection_detected',
                  target: url.substring(0, 200),
                  details: JSON.stringify({ severity: scan.severity }),
                });
                throw new Error(`ASI01: Fetched content contains critical injection patterns — blocked`);
              }
            }

            return result;
          },
        },
      },

      // Agent config
      config: agentConfig,

      // Structured logger
      log: {
        info: (msg, data) => {
          console.log(`[${agentId}] ${msg}`, data || '');
          self.activityLog.append({ actor: agentId, action: 'log_info', details: msg });
        },
        warn: (msg, data) => {
          console.warn(`[${agentId}] WARN: ${msg}`, data || '');
          self.activityLog.append({ actor: agentId, action: 'log_warn', details: msg });
        },
        error: (msg, data) => {
          console.error(`[${agentId}] ERROR: ${msg}`, data || '');
          self.activityLog.append({ actor: agentId, action: 'log_error', details: msg });
          self._postToChannel('chan_alerts', `[${agentId}] ERROR: ${msg}`, agentId);
        },
      },
    };
  }

  // --- Internal helpers ---

  async _postToChannel(channelId, body, fromUser, opts = {}) {
    const crypto = require('crypto');
    const id = crypto.randomUUID();

    // [CLAIM VERIFICATION] Verify agent claims before saving
    let metadataStr = null;
    if (this.claimVerifier && fromUser && fromUser.startsWith('agent_')) {
      try {
        const verification = await this.claimVerifier.verify(body, fromUser);
        if (verification) {
          metadataStr = JSON.stringify({ claimVerification: verification });
        }
      } catch (e) {
        // Non-blocking — verification failure does not prevent posting
        console.warn('[WorkerRuntime] Claim verification error:', e.message);
      }
    }

    this.db.run(
      'INSERT INTO messages (id, channel_id, from_user, body, priority, type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, channelId, fromUser, body, opts.priority || 'normal', opts.type || 'message', metadataStr],
      (err) => {
        if (err) return console.error('[WorkerRuntime] Post failed:', err.message);
        const message = { id, channel_id: channelId, from_user: fromUser, body, type: 'message', created_at: new Date().toISOString(), metadata: metadataStr ? JSON.parse(metadataStr) : null };
        if (this.io) this.io.to(channelId).emit('new_message', message);
      }
    );
  }

  _getMessages(channelId, opts = {}) {
    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM messages WHERE channel_id = ?';
      const params = [channelId];
      if (opts.since) { sql += ' AND created_at > ?'; params.push(opts.since); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(opts.limit || 50);
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).reverse());
      });
    });
  }

  _createTask({ title, assignee, priority = 3, description, createdBy }) {
    const crypto = require('crypto');
    const id = crypto.randomUUID();
    this.db.run(
      'INSERT INTO tasks (id, title, description, assignee, created_by, priority) VALUES (?, ?, ?, ?, ?, ?)',
      [id, title, description, assignee, createdBy, priority],
      (err) => {
        if (err) console.error('[WorkerRuntime] Task create failed:', err.message);
        else if (this.io) this.io.emit('task_update', { action: 'created', task: { id, title, assignee, priority } });
      }
    );
  }

  _pingHealth(agentId, status = 'active') {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO agent_heartbeats (agent, status, last_ping_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET status = ?, last_ping_at = ?`,
      [agentId, status, now, status, now]
    );
  }

  /**
   * Create an approval request on behalf of a worker agent.
   * Returns a promise that resolves with the created approval record.
   */
  _requestApproval(agentId, actionType, actionDetail) {
    const crypto = require('crypto');
    const id = `appr_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO approval_queue (id, requested_by, action_type, action_detail, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [id, agentId, actionType, actionDetail, now],
        (err) => {
          if (err) return reject(new Error(`Failed to create approval request: ${err.message}`));

          console.log(`[WorkerRuntime] Approval request ${id} from ${agentId}: ${actionType}`);

          this.activityLog.append({
            actor: agentId,
            action: 'approval_requested',
            target: id,
            details: JSON.stringify({ action_type: actionType, action_detail: actionDetail }),
          });

          // Notify connected clients via WebSocket
          if (this.io) {
            this.io.emit('approval_update', {
              id, requested_by: agentId, action_type: actionType,
              action_detail: actionDetail, status: 'pending', created_at: now,
            });
          }

          this.db.get('SELECT * FROM approval_queue WHERE id = ?', [id], (err2, row) => {
            if (err2) return reject(err2);
            resolve(row);
          });
        }
      );
    });
  }

  /**
   * Route an incoming message to any workers with matching listeners.
   * Called by the auto-responder when a message arrives.
   *
   * Returns true if any worker handled the message, false otherwise.
   */
  async onMessage(channelId, fromUser, body) {
    const matchedListeners = [];

    for (const listener of this.messageListeners) {
      for (const pattern of listener.patterns) {
        if (pattern.test(body)) {
          matchedListeners.push(listener);
          break; // Don't match same listener twice
        }
      }
    }

    if (matchedListeners.length === 0) return false;

    console.log(`[WorkerRuntime] Message matched ${matchedListeners.length} listener(s)`);

    for (const listener of matchedListeners) {
      const worker = this.workers.get(listener.workerId);
      if (!worker) continue;

      // Don't respond to own messages
      if (fromUser === listener.workerId) continue;

      // Execute listener in error isolation
      const startTime = Date.now();
      console.log(`[WorkerRuntime] ${listener.workerId}.${listener.listenerName} triggered by "${body.substring(0, 40)}"`);

      this.activityLog.append({
        actor: listener.workerId,
        action: 'listener_triggered',
        target: listener.listenerName,
        details: JSON.stringify({ from: fromUser, channel: channelId, preview: body.substring(0, 80) }),
      });

      try {
        await Promise.race([
          listener.handler(listener.context, { channelId, fromUser, body }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Listener timeout')), listener.timeout)
          ),
        ]);

        const elapsed = Date.now() - startTime;
        console.log(`[WorkerRuntime] ${listener.workerId}.${listener.listenerName} completed (${elapsed}ms)`);
      } catch (e) {
        console.error(`[WorkerRuntime] ${listener.workerId}.${listener.listenerName} failed:`, e.message);
        this.activityLog.append({
          actor: listener.workerId,
          action: 'listener_failed',
          target: listener.listenerName,
          details: JSON.stringify({ error: e.message }),
        });
      }
    }

    return true;
  }

  /**
   * [ASI08] Disable a specific agent without triggering lockdown.
   * Stops all cron jobs and marks the worker as disabled.
   * The agent's messages are still accepted but tasks won't execute.
   */
  disableWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false, error: `Worker ${workerId} not found` };

    for (const { job } of worker.cronJobs) {
      job.stop();
    }

    // For forked workers, also send shutdown to child process
    if (worker.forked && worker.childProcess?.connected) {
      worker.childProcess.send({ type: 'shutdown' });
    }

    worker.status = 'disabled';
    worker.disabled = true;

    this.activityLog.append({
      actor: 'admin',
      action: 'worker_disabled',
      target: workerId,
    });

    console.log(`[WorkerRuntime] ${workerId} DISABLED by admin`);
    return { ok: true, workerId, status: 'disabled' };
  }

  /**
   * [ASI08] Re-enable a previously disabled agent.
   * Restarts cron jobs.
   */
  enableWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return { ok: false, error: `Worker ${workerId} not found` };

    for (const { job } of worker.cronJobs) {
      job.start();
    }
    worker.status = 'idle';
    worker.disabled = false;

    this.activityLog.append({
      actor: 'admin',
      action: 'worker_enabled',
      target: workerId,
    });

    console.log(`[WorkerRuntime] ${workerId} ENABLED by admin`);
    return { ok: true, workerId, status: 'enabled' };
  }

  /**
   * Get status of all workers for dashboard.
   */
  getStatus() {
    const status = [];
    for (const [id, worker] of this.workers) {
      status.push({
        id,
        name: worker.name,
        status: worker.status,
        disabled: worker.disabled || false,
        running: worker.running,
        lastRun: worker.lastRun,
        tasks: worker.cronJobs.map(j => ({ name: j.taskName, schedule: j.schedule })),
      });
    }
    return status;
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    console.log('[WorkerRuntime] Shutting down...');
    for (const [id, worker] of this.workers) {
      for (const { job } of worker.cronJobs) {
        job.stop();
      }
      // Kill forked child processes
      if (worker.forked && worker.childProcess?.connected) {
        worker.childProcess.send({ type: 'shutdown' });
        // Give it 5 seconds to exit gracefully, then force kill
        setTimeout(() => {
          if (worker.childProcess?.connected) {
            worker.childProcess.kill('SIGKILL');
          }
        }, 5000);
      }
      console.log(`[WorkerRuntime] ${id} stopped${worker.forked ? ' (child process)' : ''}`);
    }
    // Clean up sandbox resources
    this.sandbox.shutdown();
  }
}

module.exports = { WorkerRuntime };
