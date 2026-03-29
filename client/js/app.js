/**
 * Darkhan — Client Application
 * Vanilla JS SPA: login, channels, real-time messaging, tasks, workers, costs.
 */

(function () {
  'use strict';

  // --- State ---
  let currentUser = null;
  let currentChannel = 'chan_command';
  let currentView = 'chat'; // 'chat' | 'dashboard' | 'tasks' | 'approvals' | 'workers' | 'costs'
  let teamData = null; // loaded from /api/team
  let socket = null;

  // --- DOM refs ---
  const loginScreen = document.getElementById('login-screen');
  const appScreen = document.getElementById('app-screen');
  const loginForm = document.getElementById('login-form');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');
  const messageContainer = document.getElementById('message-container');
  const channelList = document.getElementById('channel-list');
  const viewList = document.getElementById('view-list');
  const currentChannelName = document.getElementById('current-channel-name');
  const currentUserSpan = document.getElementById('current-user');
  const logoutBtn = document.getElementById('logout-btn');

  // --- API helpers ---
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // --- Auth ---
  async function checkSession() {
    try {
      const user = await api('GET', '/auth/me');
      currentUser = user;
      showApp();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
  }

  async function showApp() {
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    currentUserSpan.textContent = currentUser.username;

    // Load team data and build dynamic sidebar
    try {
      teamData = await api('GET', '/team');
      const brandEl = document.getElementById('brand-name');
      if (brandEl && teamData.instance?.brandName) {
        brandEl.textContent = teamData.instance.brandName;
        document.title = `${teamData.instance.brandName} — Command Center`;
      }
      buildChannelList();
      buildTeamStatus();
    } catch (e) {
      console.warn('Team data load failed:', e.message);
    }

    // Show admin section if admin
    if (currentUser.role === 'admin') {
      document.getElementById('admin-section').style.display = '';
    }

    connectSocket();
    loadMessages();
    updateAgentStatus();
    setInterval(updateAgentStatus, 30000);
  }

  // Build channel list dynamically from config
  async function buildChannelList() {
    channelList.innerHTML = '';
    let channels = [];

    try {
      const config = await api('GET', '/team');
      // Server exposes channels via config — pull from darkhan.config.json
      const configRes = await fetch('/api/vault/tree?depth=0').catch(() => null);
      // Fallback: read channels from database
      channels = [
        { id: 'chan_command', name: '#command' },
        { id: 'chan_claude', name: '#claude' },
        { id: 'chan_lindsey', name: '#lindsey' },
        { id: 'chan_penny', name: '#penny' },
        { id: 'chan_chief', name: '#chief' },
        { id: 'chan_darkhan', name: '#darkhan' },
        { id: 'chan_coordination', name: '#coordination' },
        { id: 'chan_alerts', name: '#alerts' },
      ];
    } catch (e) {
      channels = [{ id: 'chan_command', name: '#command' }];
    }

    channels.forEach(ch => {
      const li = document.createElement('li');
      li.dataset.channel = ch.id;
      li.textContent = ch.name;
      if (ch.id === currentChannel) li.classList.add('active');
      channelList.appendChild(li);
    });
  }

  // Build team status panel dynamically from /api/team
  function buildTeamStatus() {
    const container = document.getElementById('agent-status-lights');
    if (!container || !teamData?.members) return;
    container.innerHTML = '';

    teamData.members.forEach(member => {
      const row = document.createElement('div');
      row.className = 'status-row';
      const dotId = `status-${member.id.replace(/^(agent_|user_)/, '')}`;
      row.innerHTML = `<span class="status-dot grey" id="${dotId}"></span> ${escapeHtml(member.name)}`;
      container.appendChild(row);
    });
  }

  // --- Agent Status Lights (dynamic) ---
  async function updateAgentStatus() {
    if (!teamData?.members) return;

    // Darkhan system agent is always green (it IS the server)
    const darkhanDot = document.getElementById('status-darkhan');
    if (darkhanDot) darkhanDot.className = 'status-dot green';

    try {
      const statusData = await api('GET', '/health/status').catch(() => ({ agents: [] }));
      const heartbeats = {};
      (statusData.agents || []).forEach(a => { heartbeats[a.agent] = a; });

      // Also check recent messages for activity
      const msgs = await api('GET', '/messages?channel=chan_command&limit=100');
      const messages = msgs.messages || [];
      const now = Date.now();
      const lastSeen = {};
      messages.forEach(m => {
        if (!lastSeen[m.from_user]) {
          lastSeen[m.from_user] = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').getTime();
        }
      });

      teamData.members.forEach(member => {
        const dotId = `status-${member.id.replace(/^(agent_|user_)/, '')}`;
        const dot = document.getElementById(dotId);
        if (!dot) return;

        // System agent (Darkhan) always green
        if (member.role === 'system') { dot.className = 'status-dot green'; return; }

        // Check heartbeat first, then message activity
        const hb = heartbeats[member.id];
        const lastMsg = lastSeen[member.id];
        const lastActivity = Math.max(
          hb?.last_ping_at ? new Date(hb.last_ping_at).getTime() : 0,
          lastMsg || 0
        );

        if (!lastActivity) { dot.className = 'status-dot grey'; return; }

        const ageMins = (now - lastActivity) / 60000;
        if (ageMins < 10) dot.className = 'status-dot green';
        else if (ageMins < 60) dot.className = 'status-dot amber';
        else dot.className = 'status-dot red';
      });
    } catch (e) {
      console.warn('Status update failed:', e.message);
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    try {
      const data = await api('POST', '/auth/login', { username, password });
      currentUser = data.user;
      showApp();
    } catch (err) {
      alert(err.message);
    }
  });

  // Admin settings nav
  document.getElementById('nav-settings')?.addEventListener('click', () => {
    currentView = 'settings';
    showView('settings');
    channelList.querySelectorAll('li').forEach(el => el.classList.remove('active'));
    viewList.querySelectorAll('li').forEach(el => el.classList.remove('active'));
  });

  logoutBtn.addEventListener('click', async () => {
    try {
      await api('POST', '/auth/logout');
    } catch { /* ignore */ }
    currentUser = null;
    if (socket) socket.disconnect();
    showLogin();
  });

  // --- WebSocket ---
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io();

    socket.on('connect', () => {
      socket.emit('join_channel', currentChannel);
    });

    socket.on('delete_message', (data) => {
      if (data.channel_id === currentChannel) {
        const el = document.querySelector(`[data-message-id="${data.id}"]`);
        if (el) el.remove();
      }
    });

    socket.on('new_message', (msg) => {
      if (msg.channel_id === currentChannel && currentView === 'chat') {
        appendMessage(msg);
        scrollToBottom();
      }
    });

    socket.on('task_update', (data) => {
      if (currentView === 'tasks') {
        loadTasks();
      }
    });

    socket.on('agent_health', () => {
      if (currentView === 'dashboard') {
        loadDashboard();
      }
      updateAgentStatus();
    });

    // Update status lights when any new message arrives (dynamic)
    socket.on('new_message', (msg) => {
      const dotId = `status-${(msg.from_user || '').replace(/^(agent_|user_)/, '')}`;
      const dot = document.getElementById(dotId);
      if (dot) dot.className = 'status-dot green';
    });
  }

  // --- Channels ---
  channelList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-channel]');
    if (!li) return;

    // Leave old channel, join new
    if (socket) {
      socket.emit('leave_channel', currentChannel);
    }
    currentChannel = li.dataset.channel;
    if (socket) {
      socket.emit('join_channel', currentChannel);
    }

    // Update UI
    channelList.querySelectorAll('li').forEach(el => el.classList.remove('active'));
    li.classList.add('active');
    currentChannelName.textContent = li.textContent;
    messageInput.placeholder = `Message ${li.textContent}...`;

    currentView = 'chat';
    showView('chat');
    loadMessages();
  });

  // --- Views ---
  viewList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-view]');
    if (!li) return;
    currentView = li.dataset.view;
    showView(currentView);

    // Deselect channels
    channelList.querySelectorAll('li').forEach(el => el.classList.remove('active'));

    if (currentView === 'tasks') loadTasks();
    if (currentView === 'dashboard') loadDashboard();
    if (currentView === 'approvals') loadApprovals();
    if (currentView === 'workers') loadWorkers();
    if (currentView === 'costs') loadCosts();
    if (currentView === 'docs') loadDocs();
    if (currentView === 'settings') checkLockdownStatus();
  });

  function showView(view) {
    const chatView = document.getElementById('chat-view');
    // Lazily create dashboard/task views if they don't exist
    let dashView = document.getElementById('dashboard-view');
    let taskView = document.getElementById('tasks-view');

    if (!dashView) {
      dashView = document.createElement('div');
      dashView.id = 'dashboard-view';
      dashView.className = 'view hidden';
      dashView.innerHTML = '<header class="channel-header"><h2>Dashboard</h2></header><div id="dashboard-content" class="content-area"><p>Loading...</p></div>';
      document.getElementById('main-content').appendChild(dashView);
    }
    if (!taskView) {
      taskView = document.createElement('div');
      taskView.id = 'tasks-view';
      taskView.className = 'view hidden';
      taskView.innerHTML = '<header class="channel-header"><h2>Tasks</h2></header><div id="tasks-content" class="content-area"><p>Loading...</p></div>';
      document.getElementById('main-content').appendChild(taskView);
    }

    // Approvals view
    let appView = document.getElementById("approvals-view");
    if (!appView) {
      appView = document.createElement("div");
      appView.id = "approvals-view";
      appView.className = "view hidden";
      appView.innerHTML = '<header class="channel-header"><h2>Approvals</h2></header><div id="approvals-content" class="content-area"><p>Loading...</p></div>';
      document.getElementById("main-content").appendChild(appView);
    }

    // Workers view
    let workView = document.getElementById('workers-view');
    if (!workView) {
      workView = document.createElement('div');
      workView.id = 'workers-view';
      workView.className = 'view hidden';
      workView.innerHTML = '<header class="channel-header"><h2>Workers</h2></header><div id="workers-content" class="content-area"><p>Loading...</p></div>';
      document.getElementById('main-content').appendChild(workView);
    }

    // Costs view
    let costView = document.getElementById('costs-view');
    if (!costView) {
      costView = document.createElement('div');
      costView.id = 'costs-view';
      costView.className = 'view hidden';
      costView.innerHTML = '<header class="channel-header"><h2>Costs</h2></header><div id="costs-content" class="content-area"><p>Loading...</p></div>';
      document.getElementById('main-content').appendChild(costView);
    }

    // Docs view (knowledge base)
    let docsView = document.getElementById('docs-view');
    if (!docsView) {
      docsView = document.createElement('div');
      docsView.id = 'docs-view';
      docsView.className = 'view hidden';
      docsView.style.cssText = 'display:flex;flex-direction:column;height:100%;';
      docsView.innerHTML = `
        <header class="channel-header" style="display:flex;align-items:center;gap:1rem;">
          <h2>Docs</h2>
          <div style="flex:1;">
            <input type="text" id="docs-search" placeholder="Search files..." style="width:100%;padding:0.4rem 0.8rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.9rem;">
          </div>
        </header>
        <div id="docs-container" style="display:flex;flex:1;overflow:hidden;">
          <div id="docs-tree" style="width:280px;min-width:200px;overflow-y:auto;border-right:1px solid var(--border);padding:0.5rem;font-size:0.85rem;"></div>
          <div id="docs-content" style="flex:1;overflow-y:auto;padding:1.5rem;">
            <div id="docs-breadcrumb" style="font-size:0.8rem;opacity:0.6;margin-bottom:1rem;"></div>
            <div id="docs-rendered" class="markdown-body" style="line-height:1.6;"></div>
          </div>
        </div>
      `;
      document.getElementById('main-content').appendChild(docsView);
    }

    // Settings view (admin only)
    let settingsView = document.getElementById('settings-view');
    if (!settingsView) {
      settingsView = document.createElement('div');
      settingsView.id = 'settings-view';
      settingsView.className = 'view hidden';
      settingsView.innerHTML = `
        <header class="channel-header"><h2>Admin Settings</h2></header>
        <div class="content-area" style="padding:1.5rem;max-width:500px;">
          <div id="lockdown-banner" style="display:none;background:#c0392b;color:white;padding:1rem;border-radius:var(--radius);margin-bottom:1.5rem;">
            <strong>LOCKDOWN ACTIVE</strong>
            <p id="lockdown-reason" style="margin:0.5rem 0 1rem 0;font-size:0.9rem;opacity:0.9;"></p>
            <input type="password" id="unlock-pin" placeholder="Lockdown PIN" style="padding:0.5rem;border:none;border-radius:4px;margin-right:0.5rem;width:150px;">
            <button id="unlock-btn" style="padding:0.5rem 1rem;background:#27ae60;color:white;border:none;border-radius:4px;cursor:pointer;">Unlock</button>
          </div>

          <h3 style="margin-bottom:1rem;">Change Password</h3>
          <form id="change-password-form" style="display:flex;flex-direction:column;gap:0.75rem;margin-bottom:2rem;">
            <input type="password" id="cp-current" placeholder="Current password" required style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
            <input type="password" id="cp-new" placeholder="New password (8+ chars)" required minlength="8" style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
            <input type="password" id="cp-confirm" placeholder="Confirm new password" required style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);">
            <button type="submit" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;width:fit-content;">Change Password</button>
            <div id="cp-status" style="font-size:0.9rem;"></div>
          </form>

          <h3 style="margin-bottom:1rem;">Lockdown PIN</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Set a PIN that's required to unlock the system. Only you should know this — agents cannot access it.</p>
          <form id="set-pin-form" style="display:flex;flex-direction:column;gap:0.75rem;margin-bottom:2rem;">
            <input type="password" id="pin-new" placeholder="New PIN (4+ chars)" required minlength="4" style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:200px;">
            <input type="password" id="pin-confirm" placeholder="Confirm PIN" required style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:200px;">
            <button type="submit" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;width:fit-content;">Set Lockdown PIN</button>
            <div id="pin-status" style="font-size:0.9rem;"></div>
          </form>

          <h3 style="margin-bottom:1rem;">Manual Lockdown</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Immediately halt all agent operations. Only you can unlock.</p>
          <button id="manual-lockdown-btn" style="padding:0.5rem 1rem;background:#c0392b;color:white;border:none;border-radius:4px;cursor:pointer;">Trigger Lockdown</button>
        </div>
      `;
      document.getElementById('main-content').appendChild(settingsView);

      // Wire up settings forms
      document.getElementById('change-password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('cp-status');
        const newPw = document.getElementById('cp-new').value;
        const confirmPw = document.getElementById('cp-confirm').value;
        if (newPw !== confirmPw) { status.textContent = 'Passwords do not match'; status.style.color = '#e74c3c'; return; }
        try {
          await api('POST', '/auth/change-password', { currentPassword: document.getElementById('cp-current').value, newPassword: newPw });
          status.textContent = 'Password changed successfully'; status.style.color = '#27ae60';
          e.target.reset();
        } catch (err) { status.textContent = err.message; status.style.color = '#e74c3c'; }
      });

      document.getElementById('set-pin-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('pin-status');
        const pin = document.getElementById('pin-new').value;
        const confirm = document.getElementById('pin-confirm').value;
        if (pin !== confirm) { status.textContent = 'PINs do not match'; status.style.color = '#e74c3c'; return; }
        try {
          await api('POST', '/auth/set-lockdown-pin', { pin });
          status.textContent = 'Lockdown PIN set successfully'; status.style.color = '#27ae60';
          e.target.reset();
        } catch (err) { status.textContent = err.message; status.style.color = '#e74c3c'; }
      });

      document.getElementById('unlock-btn').addEventListener('click', async () => {
        const pin = document.getElementById('unlock-pin').value;
        try {
          await api('POST', '/security/unlock', { pin });
          document.getElementById('lockdown-banner').style.display = 'none';
          alert('System unlocked');
        } catch (err) { alert('Unlock failed: ' + err.message); }
      });

      document.getElementById('manual-lockdown-btn').addEventListener('click', async () => {
        if (!confirm('Trigger lockdown? All agent operations will be halted until you unlock.')) return;
        try {
          await api('POST', '/security/lockdown', { reason: 'Manual lockdown by admin' });
          alert('Lockdown activated');
          checkLockdownStatus();
        } catch (err) { alert('Lockdown failed: ' + err.message); }
      });
    }

    // Check lockdown status when settings view is shown
    if (view === 'settings') checkLockdownStatus();

    chatView.classList.toggle('hidden', view !== 'chat');
    dashView.classList.toggle('hidden', view !== 'dashboard');
    taskView.classList.toggle('hidden', view !== 'tasks');
    appView.classList.toggle('hidden', view !== 'approvals');
    workView.classList.toggle('hidden', view !== 'workers');
    costView.classList.toggle('hidden', view !== 'costs');
    if (settingsView) settingsView.classList.toggle('hidden', view !== 'settings');
    if (docsView) docsView.classList.toggle('hidden', view !== 'docs');
    // Override display for docs (needs flex, not block)
    if (view === 'docs' && docsView) docsView.style.display = 'flex';
    else if (docsView) docsView.style.display = 'none';
  }

  // Check and display lockdown status
  async function checkLockdownStatus() {
    try {
      const data = await api('GET', '/security');
      const banner = document.getElementById('lockdown-banner');
      if (data.lockdown?.active) {
        banner.style.display = 'block';
        document.getElementById('lockdown-reason').textContent = data.lockdown.reason || 'Unknown reason';
      } else {
        banner.style.display = 'none';
      }
    } catch { /* ignore */ }
  }

  // --- Messages ---
  async function loadMessages() {
    messageContainer.innerHTML = '';
    try {
      const data = await api('GET', `/messages?channel=${currentChannel}&limit=300`);
      data.messages.forEach(appendMessage);
      scrollToBottom(true);  // Force scroll on initial load
    } catch (err) {
      messageContainer.innerHTML = `<p class="error">Failed to load messages: ${err.message}</p>`;
    }
  }

  function appendMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.type || 'message'}`;
    if (msg.id) div.setAttribute('data-message-id', msg.id);
    if (msg.priority === 'critical') div.classList.add('critical');

    // SQLite CURRENT_TIMESTAMP stores UTC without 'Z' suffix — append it so JS parses correctly
    const utcTime = msg.created_at.endsWith('Z') ? msg.created_at : msg.created_at + 'Z';
    const time = new Date(utcTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
    div.innerHTML = `
      <span class="msg-user">${escapeHtml(msg.from_user)}</span>
      <span class="msg-time">${time}</span>
      <div class="msg-body">${escapeHtml(msg.body)}</div>
    `;
    messageContainer.appendChild(div);
  }

  function scrollToBottom(force = false) {
    // Only auto-scroll if user is near the bottom (within 150px) or forced
    const threshold = 150;
    const isNearBottom = messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight < threshold;
    if (force || isNearBottom) {
      messageContainer.scrollTop = messageContainer.scrollHeight;
    }
  }

  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = messageInput.value.trim();
    if (!body) return;

    // /claude command — invoke Claude API
    if (body.startsWith('/claude ') || body === '/claude') {
      const query = body.replace(/^\/claude\s*/, '').trim();
      if (!query) {
        alert('Usage: /claude <your question>');
        return;
      }
      messageInput.value = '';

      // Post the admin's question as a regular message first
      try {
        await api('POST', '/messages', { channel_id: currentChannel, body: query });
      } catch (err) { /* continue even if message post fails */ }

      // Show thinking indicator
      const thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'message claude-thinking';
      thinkingDiv.innerHTML = `
        <span class="msg-user">claude-api</span>
        <span class="msg-time">now</span>
        <div class="msg-body thinking-pulse">Thinking...</div>
      `;
      messageContainer.appendChild(thinkingDiv);
      scrollToBottom();

      try {
        const result = await api('POST', '/claude/message', {
          channel_id: currentChannel,
          message: query
        });

        // Remove thinking indicator
        thinkingDiv.remove();

        // Claude's response is already posted to the channel via tool_executor,
        // but also show token usage
        if (result.token_usage) {
          const tokenDiv = document.createElement('div');
          tokenDiv.className = 'message token-info';
          tokenDiv.innerHTML = `
            <span class="msg-user">daryl</span>
            <span class="msg-time">now</span>
            <div class="msg-body" style="font-size:0.8rem;color:var(--text-muted);">Claude API: ${result.token_usage.input || '?'}in / ${result.token_usage.output || '?'}out tokens</div>
          `;
          messageContainer.appendChild(tokenDiv);
        }

        // Reload messages to get Claude's response from DB
        await loadMessages();
      } catch (err) {
        thinkingDiv.remove();
        appendMessage({
          from_user: 'daryl',
          body: 'Claude API error: ' + err.message,
          created_at: new Date().toISOString(),
          type: 'error'
        });
      }
      scrollToBottom();
      return;
    }

    // Regular message
    try {
      await api('POST', '/messages', { channel_id: currentChannel, body });
      messageInput.value = '';
    } catch (err) {
      alert('Failed to send: ' + err.message);
    }
  });

  // --- Tasks ---
  async function loadTasks() {
    const container = document.getElementById('tasks-content');
    if (!container) return;
    try {
      const data = await api('GET', '/tasks');
      if (data.tasks.length === 0) {
        container.innerHTML = '<p class="empty">No tasks.</p>';
        return;
      }
      const priorityLabels = { 1: '🔴 Critical', 2: '🟠 High', 3: '🟡 Normal', 4: '🟢 Low' };
      container.innerHTML = data.tasks.map(t => `
        <div class="task-card status-${t.status}">
          <div class="task-header">
            <strong>${escapeHtml(t.title)}</strong>
            <span class="task-priority">${priorityLabels[t.priority] || t.priority}</span>
          </div>
          <div class="task-meta">Assigned: ${escapeHtml(t.assignee)} | Status: ${t.status}</div>
          ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load tasks: ${err.message}</p>`;
    }
  }

  // --- Dashboard ---
  async function loadDashboard() {
    const container = document.getElementById('dashboard-content');
    if (!container) return;
    try {
      const statusData = await api('GET', '/health/status');
      const colorIcons = { green: '🟢', amber: '🟡', red: '🔴', grey: '⚪' };

      // Build labels dynamically from team data (same source as sidebar)
      const agentLabels = {};
      const roleLabels = {
        'agent_claude': 'CoS/CTO', 'agent_lindsey': 'COO', 'agent_penny': 'CFO/CMO',
        'agent_chief': 'Executive Assistant', 'agent_darkhan': 'Security',
      };
      if (teamData?.members) {
        teamData.members.forEach(m => {
          agentLabels[m.id] = `${m.name} (${roleLabels[m.id] || m.role})`;
        });
      }

      // Build heartbeat lookup
      const heartbeats = {};
      (statusData.agents || []).forEach(a => { heartbeats[a.agent] = a; });

      // Also check recent messages for activity (same logic as sidebar)
      let lastSeen = {};
      try {
        const msgs = await api('GET', '/messages?channel=chan_command&limit=100');
        (msgs.messages || []).forEach(m => {
          if (!lastSeen[m.from_user]) {
            lastSeen[m.from_user] = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').getTime();
          }
        });
      } catch (e) { /* */ }

      let html = '<div class="dashboard-grid">';
      html += '<div class="dash-section"><h3>Team Status</h3>';

      // Show ALL team members from config, not just those with heartbeat data
      const members = teamData?.members || [];
      if (members.length === 0) {
        html += '<p class="empty">No team data loaded.</p>';
      } else {
        const now = Date.now();
        members.forEach(m => {
          // Determine status color using same logic as sidebar
          let color = 'grey';
          if (m.role === 'system') {
            color = 'green'; // Darkhan is always green
          } else {
            const hb = heartbeats[m.id];
            const lastMsg = lastSeen[m.id];
            const hbTime = hb?.last_ping_at ? new Date(hb.last_ping_at).getTime() : 0;
            const lastActivity = Math.max(hbTime, lastMsg || 0);
            if (lastActivity) {
              const ageMins = (now - lastActivity) / 60000;
              if (ageMins < 10) color = 'green';
              else if (ageMins < 60) color = 'amber';
              else color = 'red';
            }
          }

          const icon = colorIcons[color] || '❓';
          const label = agentLabels[m.id] || `${m.name} (${m.type})`;
          const hb = heartbeats[m.id];
          const timeStr = hb?.seconds_ago !== null && hb?.seconds_ago !== undefined
            ? `${hb.seconds_ago}s ago`
            : lastSeen[m.id] ? `${Math.round((now - lastSeen[m.id]) / 1000)}s ago` : 'no activity';

          html += `<div class="agent-card" style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;margin-bottom:0.5rem;background:var(--bg-secondary);border-radius:var(--radius);">
            <span style="font-size:1.5rem;">${icon}</span>
            <div>
              <strong>${escapeHtml(label)}</strong>
              <div style="font-size:0.85rem;opacity:0.7;">Last activity: ${timeStr}</div>
            </div>
          </div>`;
        });
      }
      html += '</div>';

      // Worker status section
      try {
        const workerData = await api('GET', '/workers');
        if (workerData.workers && workerData.workers.length > 0) {
          html += '<div class="dash-section"><h3>Workers</h3>';
          workerData.workers.forEach(w => {
            const statusIcon = w.status === 'busy' ? '🔵' : '🟢';
            html += `<div style="margin-bottom:0.3rem;font-size:0.9rem;">${statusIcon} <strong>${escapeHtml(w.name)}</strong> — ${w.status} (${w.tasks.length} tasks)</div>`;
          });
          html += '</div>';
        }
      } catch (e) { /* */ }

      html += '</div>';
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load dashboard: ${err.message}</p>`;
    }
  }

  // Auto-refresh dashboard every 15s when visible
  setInterval(() => {
    if (currentView === 'dashboard') loadDashboard();
  }, 15000);

  // --- Util ---
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Approvals ---
  async function loadApprovals() {
    const container = document.getElementById('approvals-content');
    if (!container) return;
    try {
      const data = await api('GET', '/approvals?status=pending');
      if (!data.approvals || data.approvals.length === 0) {
        container.innerHTML = '<p class="empty">No pending approvals.</p>';
        return;
      }
      container.innerHTML = data.approvals.map(a => `
        <div class="task-card status-${a.status}">
          <div class="task-header">
            <strong>${escapeHtml(a.action_type)}</strong>
            <span class="task-priority">${a.status.toUpperCase()}</span>
          </div>
          <div class="task-meta">Requested by: ${escapeHtml(a.requested_by)} | ${new Date(a.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</div>
          <div class="task-desc">${escapeHtml(a.action_detail)}</div>
          <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
            <button onclick="handleApproval('${a.id}','approved')" style="background:var(--success);color:#000;border:none;padding:0.3rem 0.8rem;border-radius:var(--radius);cursor:pointer;">Approve</button>
            <button onclick="handleApproval('${a.id}','denied')" style="background:var(--danger);color:#fff;border:none;padding:0.3rem 0.8rem;border-radius:var(--radius);cursor:pointer;">Deny</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load approvals: ${err.message}</p>`;
    }
  }

  // Make handleApproval available globally for onclick
  window.handleApproval = async function(id, status) {
    try {
      await api('PATCH', `/approvals/${id}`, { status });
      loadApprovals(); // Refresh
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  };

  // --- Workers ---
  async function loadWorkers() {
    const container = document.getElementById('workers-content');
    if (!container) return;
    try {
      const data = await api('GET', '/workers');
      const rateData = await api('GET', '/rates');

      if (!data.workers || data.workers.length === 0) {
        container.innerHTML = '<p class="empty">No workers loaded.</p>';
        return;
      }

      let html = '<div class="dashboard-grid">';
      data.workers.forEach(w => {
        const statusIcon = w.status === 'busy' ? '🔵' : w.status === 'idle' ? '🟢' : '⚪';
        const lastRunStr = w.lastRun
          ? `${w.lastRun.task} (${w.lastRun.status}, ${w.lastRun.elapsed}ms)`
          : 'never';

        html += `<div class="task-card status-${w.status}" style="margin-bottom:1rem;">
          <div class="task-header">
            <strong>${statusIcon} ${escapeHtml(w.name)}</strong>
            <span class="task-priority">${w.status.toUpperCase()}</span>
          </div>
          <div class="task-meta">Running: ${w.running || 'none'} | Last: ${lastRunStr}</div>
          <div style="margin-top:0.5rem;">
            ${w.tasks.map(t => `<div style="font-size:0.85rem;opacity:0.8;margin:0.2rem 0;">• ${t.name}: <code>${t.schedule}</code></div>`).join('')}
          </div>
        </div>`;
      });

      // Rate limiter summary
      if (rateData.providers) {
        html += '<div class="dash-section"><h3>Rate Limits</h3>';
        Object.entries(rateData.providers).forEach(([provider, info]) => {
          const pct = info.limit > 0 ? Math.round((info.used / info.limit) * 100) : 0;
          html += `<div style="margin-bottom:0.5rem;">
            <strong>${provider}</strong>: ${info.used}/${info.limit || '∞'} RPD (${pct}%)
            | ${info.perMinute.used}/${info.perMinute.limit || '∞'} RPM
          </div>`;
        });
        html += '</div>';
      }

      html += '</div>';
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load workers: ${err.message}</p>`;
    }
  }

  // --- Costs ---
  async function loadCosts() {
    const container = document.getElementById('costs-content');
    if (!container) return;
    try {
      const daily = await api('GET', '/costs/daily');
      const total = await api('GET', '/costs/total');

      let html = '<div class="dashboard-grid">';

      // Today's costs
      html += '<div class="dash-section"><h3>Today</h3>';
      if (!daily.summary || daily.summary.length === 0) {
        html += '<p class="empty">No API calls today.</p>';
      } else {
        html += '<table style="width:100%;font-size:0.9rem;"><tr><th>Agent</th><th>Provider</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr>';
        daily.summary.forEach(row => {
          const cost = (row.total_cost_millicents / 100).toFixed(2);
          html += `<tr>
            <td>${escapeHtml(row.agent)}</td>
            <td>${escapeHtml(row.provider)}/${escapeHtml(row.model)}</td>
            <td>${row.request_count}</td>
            <td>${row.total_tokens_in}in / ${row.total_tokens_out}out</td>
            <td>$${cost}</td>
          </tr>`;
        });
        html += '</table>';
      }
      html += '</div>';

      // All-time totals
      html += '<div class="dash-section"><h3>All Time</h3>';
      if (!total.summary || total.summary.length === 0) {
        html += '<p class="empty">No cost data yet.</p>';
      } else {
        html += '<table style="width:100%;font-size:0.9rem;"><tr><th>Agent</th><th>Requests</th><th>Total Cost</th></tr>';
        total.summary.forEach(row => {
          const cost = (row.total_cost_millicents / 100).toFixed(2);
          html += `<tr>
            <td>${escapeHtml(row.agent)}</td>
            <td>${row.total_requests}</td>
            <td>$${cost}</td>
          </tr>`;
        });
        html += '</table>';
      }
      html += '</div>';

      html += '</div>';
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load costs: ${err.message}</p>`;
    }
  }

  // --- Docs (Knowledge Base) ---
  let docsCurrentPath = null;

  async function loadDocs() {
    const treeContainer = document.getElementById('docs-tree');
    const contentContainer = document.getElementById('docs-rendered');
    const breadcrumb = document.getElementById('docs-breadcrumb');
    if (!treeContainer) return;

    try {
      const data = await api('GET', '/vault/tree?depth=4');
      treeContainer.innerHTML = renderTree(data.tree, 0);
      if (!docsCurrentPath) {
        contentContainer.innerHTML = '<p style="opacity:0.5;">Select a file from the tree to view it.</p>';
        breadcrumb.textContent = '/';
      }
    } catch (err) {
      treeContainer.innerHTML = `<p class="error">Failed to load: ${err.message}</p>`;
    }

    // Search handler
    const searchInput = document.getElementById('docs-search');
    if (searchInput && !searchInput._bound) {
      searchInput._bound = true;
      let searchTimeout;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const q = e.target.value.trim();
        if (q.length < 2) {
          loadDocs(); // Reset to tree
          return;
        }
        searchTimeout = setTimeout(() => searchVault(q), 300);
      });
    }
  }

  function renderTree(nodes, depth) {
    if (!nodes || nodes.length === 0) return '';
    let html = '';

    for (const node of nodes) {
      const indent = depth * 16;
      if (node.type === 'directory') {
        const hasChildren = node.children && node.children.length > 0;
        const toggleId = `tree-${node.path.replace(/[^a-zA-Z0-9]/g, '-')}`;
        html += `<div style="padding-left:${indent}px;">`;
        html += `<div class="tree-dir" onclick="document.getElementById('${toggleId}').classList.toggle('collapsed')" style="cursor:pointer;padding:2px 4px;border-radius:3px;display:flex;align-items:center;gap:4px;">`;
        html += `<span style="font-size:0.7rem;">&#9660;</span> <strong>${escapeHtml(node.name)}</strong>`;
        html += `</div>`;
        html += `<div id="${toggleId}" class="${depth > 1 ? 'collapsed' : ''}">${renderTree(node.children, depth + 1)}</div>`;
        html += `</div>`;
      } else {
        const isMarkdown = node.ext === '.md';
        const icon = isMarkdown ? '&#128196;' : '&#128462;';
        html += `<div style="padding-left:${indent}px;">`;
        html += `<div class="tree-file" data-path="${escapeHtml(node.path)}" onclick="window._openDoc('${escapeHtml(node.path)}')" style="cursor:pointer;padding:2px 4px;border-radius:3px;display:flex;align-items:center;gap:4px;${isMarkdown ? '' : 'opacity:0.5;'}">`;
        html += `<span style="font-size:0.7rem;">${icon}</span> ${escapeHtml(node.name)}`;
        html += `</div></div>`;
      }
    }
    return html;
  }

  let docsEditMode = false;
  let docsRawContent = '';

  window._openDoc = async function(filePath) {
    const contentContainer = document.getElementById('docs-rendered');
    const breadcrumb = document.getElementById('docs-breadcrumb');
    if (!contentContainer) return;

    docsCurrentPath = filePath;
    docsEditMode = false;
    contentContainer.innerHTML = '<p style="opacity:0.5;">Loading...</p>';

    // Highlight active file in tree
    document.querySelectorAll('.tree-file').forEach(el => el.style.background = '');
    const activeEl = document.querySelector(`.tree-file[data-path="${filePath}"]`);
    if (activeEl) activeEl.style.background = 'var(--bg-hover, rgba(255,255,255,0.1))';

    try {
      const data = await api('GET', `/vault/file?path=${encodeURIComponent(filePath)}`);
      docsRawContent = data.content;

      // Build breadcrumb with edit/save buttons
      breadcrumb.innerHTML = `
        <span style="opacity:0.6;">/ ${escapeHtml(filePath)}</span>
        <span style="float:right;display:flex;gap:0.5rem;">
          <button id="docs-edit-btn" onclick="window._toggleEdit()" style="background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:0.2rem 0.6rem;border-radius:var(--radius);cursor:pointer;font-size:0.8rem;">Edit</button>
          <button id="docs-save-btn" onclick="window._saveDoc()" style="background:var(--accent);color:#fff;border:none;padding:0.2rem 0.6rem;border-radius:var(--radius);cursor:pointer;font-size:0.8rem;display:none;">Save</button>
          <span id="docs-save-status" style="font-size:0.8rem;line-height:2;"></span>
        </span>
      `;

      _renderDocContent(data.content, data.ext);
    } catch (err) {
      contentContainer.innerHTML = `<p class="error">Failed to load file: ${err.message}</p>`;
      breadcrumb.innerHTML = `<span style="opacity:0.6;">/ ${escapeHtml(filePath)}</span>`;
    }
  };

  function _renderDocContent(content, ext) {
    const contentContainer = document.getElementById('docs-rendered');
    if (ext === '.md' && typeof marked !== 'undefined') {
      // SECURITY: Sanitize rendered markdown to prevent XSS from vault content.
      // Strip dangerous tags/attributes after markdown parsing.
      let rendered = marked.parse(content);
      rendered = rendered
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '')
        .replace(/<object\b[^>]*>.*?<\/object>/gi, '')
        .replace(/<embed\b[^>]*\/?>/gi, '')
        .replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
        .replace(/javascript\s*:/gi, 'blocked:');
      contentContainer.innerHTML = rendered;
    } else {
      contentContainer.innerHTML = `<pre style="white-space:pre-wrap;font-size:0.85rem;">${escapeHtml(content)}</pre>`;
    }
  }

  window._toggleEdit = function() {
    const contentContainer = document.getElementById('docs-rendered');
    const editBtn = document.getElementById('docs-edit-btn');
    const saveBtn = document.getElementById('docs-save-btn');
    const saveStatus = document.getElementById('docs-save-status');
    if (!contentContainer) return;

    docsEditMode = !docsEditMode;

    if (docsEditMode) {
      // Switch to edit mode — show textarea
      editBtn.textContent = 'Preview';
      saveBtn.style.display = 'inline-block';
      saveStatus.textContent = '';

      contentContainer.innerHTML = `<textarea id="docs-editor" style="
        width:100%;height:100%;min-height:500px;
        background:var(--bg-primary);color:var(--text-primary);
        border:1px solid var(--border);border-radius:var(--radius);
        padding:1rem;font-family:'SF Mono','Fira Code',monospace;
        font-size:0.9rem;line-height:1.6;resize:none;
        outline:none;
      ">${escapeHtml(docsRawContent)}</textarea>`;

      // Track changes
      document.getElementById('docs-editor').addEventListener('input', (e) => {
        docsRawContent = e.target.value;
        saveStatus.textContent = 'unsaved';
        saveStatus.style.color = 'var(--accent)';
      });
    } else {
      // Switch to preview mode — render markdown
      editBtn.textContent = 'Edit';
      saveBtn.style.display = 'none';
      const ext = docsCurrentPath ? '.' + docsCurrentPath.split('.').pop() : '';
      _renderDocContent(docsRawContent, ext);
    }
  };

  window._saveDoc = async function() {
    const saveStatus = document.getElementById('docs-save-status');
    if (!docsCurrentPath || !docsRawContent) return;

    saveStatus.textContent = 'saving...';
    saveStatus.style.color = 'var(--text-muted)';

    try {
      await api('PUT', `/vault/file?path=${encodeURIComponent(docsCurrentPath)}`, {
        content: docsRawContent
      });
      saveStatus.textContent = 'saved';
      saveStatus.style.color = 'var(--success, #4caf50)';
      setTimeout(() => { if (saveStatus.textContent === 'saved') saveStatus.textContent = ''; }, 2000);
    } catch (err) {
      saveStatus.textContent = 'save failed';
      saveStatus.style.color = 'var(--danger, #f44336)';
      alert('Save failed: ' + err.message);
    }
  };

  async function searchVault(query) {
    const treeContainer = document.getElementById('docs-tree');
    if (!treeContainer) return;

    try {
      const data = await api('GET', `/vault/search?q=${encodeURIComponent(query)}&limit=30`);

      if (data.results.length === 0) {
        treeContainer.innerHTML = `<p style="opacity:0.5;padding:0.5rem;">No results for "${escapeHtml(query)}"</p>`;
        return;
      }

      let html = `<div style="padding:0.5rem;opacity:0.6;font-size:0.8rem;">${data.count} result(s)</div>`;
      data.results.forEach(r => {
        html += `<div class="tree-file" data-path="${escapeHtml(r.path)}" onclick="window._openDoc('${escapeHtml(r.path)}')" style="cursor:pointer;padding:4px 8px;border-radius:3px;margin-bottom:2px;">`;
        html += `<div style="font-weight:bold;font-size:0.85rem;">${escapeHtml(r.name)}</div>`;
        html += `<div style="font-size:0.75rem;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.context)}</div>`;
        html += `</div>`;
      });
      treeContainer.innerHTML = html;
    } catch (err) {
      treeContainer.innerHTML = `<p class="error">Search failed: ${err.message}</p>`;
    }
  }

  // --- Init ---
  checkSession();
})();
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW registered!', reg.scope)).catch(err => console.error('SW failed', err)); }); }
