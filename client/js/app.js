/**
 * Darkhan — Client Application
 * Vanilla JS SPA: login, channels, real-time messaging, tasks, workers, costs.
 */

(function () {
  'use strict';

  // --- State ---
  let currentUser = null;
  let currentChannel = 'chan_command';
  let currentView = 'chat'; // 'chat' | 'dashboard' | 'tasks' | 'approvals' | 'workers' | 'costs' | 'terminal'
  let teamData = null; // loaded from /api/team
  let socket = null;
  let userTimezone = 'America/New_York'; // Updated on login from user profile

  // Split screen state
  let splitMode = false;
  let splitRightView = null; // what the right panel is showing

  // Terminal state
  let terminalSocket = null;
  let terminal = null;
  let fitAddon = null;
  let terminalReady = false;
  let terminalSessionKey = null;

  // Split terminal state (observer on unified session)
  let splitTerminal = null;
  let splitTerminalSocket = null;
  let splitFitAddon = null;
  let splitTerminalReady = false;
  let splitTerminalSessionKey = null;

  // --- Clock ---
  function startClock() {
    const localEl = document.getElementById('clock-local');
    const utcEl = document.getElementById('clock-utc');
    if (!localEl || !utcEl) return;

    function tick() {
      const now = new Date();
      localEl.textContent = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: true, timeZone: userTimezone,
      });
      utcEl.textContent = 'UTC ' + now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
        hour12: false, timeZone: 'UTC',
      });
    }

    tick();
    setInterval(tick, 1000);
  }

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
      headers: {
        'Content-Type': 'application/json',
        'X-Darkhan-Client': 'true'  // CSRF protection — proves request comes from our UI
      },
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
    // Remove force-password overlay if it exists
    const existing = document.getElementById('force-password-overlay');
    if (existing) existing.remove();
  }

  /**
   * Force password change overlay — shown after login when must_change_password is set.
   * The user cannot dismiss this or navigate away. They must set a new password.
   * @param {string} currentPassword — the password they just logged in with
   */
  function showForcePasswordChange(currentPassword) {
    loginScreen.classList.add('hidden');
    appScreen.classList.add('hidden');

    // Remove any existing overlay
    let overlay = document.getElementById('force-password-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'force-password-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:var(--bg-primary, #1e1e1e);display:flex;align-items:center;justify-content:center;z-index:10000;';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary, #2d2d2d);padding:2rem;border-radius:8px;max-width:400px;width:90%;border:1px solid var(--border, #404040);">
        <h2 style="margin:0 0 0.5rem 0;color:var(--text-primary, #e0e0e0);">Password Change Required</h2>
        <p style="color:var(--text-secondary, #aaa);font-size:0.9rem;margin:0 0 1.5rem 0;">Your account is using a temporary password. You must set a new password before continuing.</p>
        <form id="force-password-form" style="display:flex;flex-direction:column;gap:0.75rem;">
          <input type="password" id="fcp-new" placeholder="New password (8+ characters)" required minlength="8"
            style="padding:0.6rem;background:var(--bg-primary, #1e1e1e);border:1px solid var(--border, #404040);border-radius:4px;color:var(--text-primary, #e0e0e0);font-size:1rem;">
          <input type="password" id="fcp-confirm" placeholder="Confirm new password" required
            style="padding:0.6rem;background:var(--bg-primary, #1e1e1e);border:1px solid var(--border, #404040);border-radius:4px;color:var(--text-primary, #e0e0e0);font-size:1rem;">
          <button type="submit" style="padding:0.6rem 1rem;background:var(--accent, #3498db);color:white;border:none;border-radius:4px;cursor:pointer;font-size:1rem;font-weight:bold;">Set New Password</button>
          <div id="fcp-status" style="font-size:0.9rem;min-height:1.2em;"></div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    // Prevent escape key from dismissing
    const blockEscape = (e) => { if (e.key === 'Escape') e.preventDefault(); };
    document.addEventListener('keydown', blockEscape);

    document.getElementById('force-password-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const status = document.getElementById('fcp-status');
      const newPw = document.getElementById('fcp-new').value;
      const confirmPw = document.getElementById('fcp-confirm').value;

      if (newPw.length < 8) {
        status.textContent = 'Password must be at least 8 characters';
        status.style.color = '#e74c3c';
        return;
      }
      if (newPw !== confirmPw) {
        status.textContent = 'Passwords do not match';
        status.style.color = '#e74c3c';
        return;
      }
      if (newPw === currentPassword) {
        status.textContent = 'New password must be different from the current password';
        status.style.color = '#e74c3c';
        return;
      }

      status.textContent = 'Changing password...';
      status.style.color = 'var(--text-secondary, #aaa)';

      try {
        await api('POST', '/auth/change-password', { currentPassword, newPassword: newPw });
        status.textContent = 'Password changed. One more step...';
        status.style.color = '#27ae60';

        // Step 2: Lockdown PIN setup
        setTimeout(() => {
          overlay.querySelector('div').innerHTML = `
            <h2 style="margin:0 0 0.5rem 0;color:var(--text-primary, #e0e0e0);">Set Lockdown PIN</h2>
            <p style="color:var(--text-secondary, #aaa);font-size:0.9rem;margin:0 0 1.5rem 0;">
              The lockdown PIN is a second factor for unlocking Darkhan after a security event.
              Choose something you will remember — if the system locks down, only this PIN can unlock it.
            </p>
            <form id="force-pin-form" style="display:flex;flex-direction:column;gap:0.75rem;">
              <input type="password" id="fpin-value" placeholder="Lockdown PIN (8+ characters)" required minlength="8"
                style="padding:0.6rem;background:var(--bg-primary, #1e1e1e);border:1px solid var(--border, #404040);border-radius:4px;color:var(--text-primary, #e0e0e0);font-size:1rem;">
              <button type="submit" style="padding:0.6rem 1rem;background:var(--accent, #3498db);color:white;border:none;border-radius:4px;cursor:pointer;font-size:1rem;font-weight:bold;">Set PIN</button>
              <div id="fpin-status" style="font-size:0.9rem;min-height:1.2em;"></div>
            </form>
          `;

          document.getElementById('force-pin-form').addEventListener('submit', async (pinEv) => {
            pinEv.preventDefault();
            const pinStatus = document.getElementById('fpin-status');
            const pinValue = document.getElementById('fpin-value').value;

            if (pinValue.length < 8) {
              pinStatus.textContent = 'PIN must be at least 8 characters';
              pinStatus.style.color = '#e74c3c';
              return;
            }

            pinStatus.textContent = 'Setting PIN...';
            pinStatus.style.color = 'var(--text-secondary, #aaa)';

            try {
              await api('POST', '/auth/set-lockdown-pin', { pin: pinValue });
              pinStatus.textContent = 'PIN set. Welcome to Darkhan.';
              pinStatus.style.color = '#27ae60';
              document.removeEventListener('keydown', blockEscape);
              setTimeout(() => {
                overlay.remove();
                showApp();
              }, 800);
            } catch (pinErr) {
              pinStatus.textContent = pinErr.message;
              pinStatus.style.color = '#e74c3c';
            }
          });
        }, 800);
      } catch (err) {
        status.textContent = err.message;
        status.style.color = '#e74c3c';
      }
    });
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
        document.title = `${teamData.instance.brandName} — The Forge`;
      }
      buildChannelList();
      buildTeamStatus();
      startClock();
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
      // Fallback: load channels from database via API
      const chanRes = await api('GET', '/channels').catch(() => null);
      if (chanRes?.channels) {
        channels = chanRes.channels;
      } else {
        channels = [
          { id: 'chan_command', name: '#command' },
          { id: 'chan_darkhan', name: '#darkhan' },
          { id: 'chan_coordination', name: '#coordination' },
          { id: 'chan_alerts', name: '#alerts' },
        ];
      }
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
        const ts = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').getTime();
        if (!lastSeen[m.from_user] || ts > lastSeen[m.from_user]) {
          lastSeen[m.from_user] = ts;
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
      userTimezone = data.user.timezone || 'America/New_York';
      if (data.mustChangePassword) {
        showForcePasswordChange(password);
        return;
      }
      showApp();
    } catch (err) {
      alert(err.message);
    }
  });

  // Password recovery toggle
  const forgotLink = document.getElementById('forgot-password-link');
  const backToLoginLink = document.getElementById('back-to-login-link');
  const recoveryScreen = document.getElementById('recovery-screen');
  const loginContainer = document.querySelector('#login-screen .login-container');

  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      loginContainer.classList.add('hidden');
      recoveryScreen.classList.remove('hidden');
    });
  }
  if (backToLoginLink) {
    backToLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      recoveryScreen.classList.add('hidden');
      loginContainer.classList.remove('hidden');
    });
  }

  const recoveryForm = document.getElementById('recovery-form');
  if (recoveryForm) {
    recoveryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('recovery-username').value.trim();
      const token = document.getElementById('recovery-token').value.trim();
      const newPassword = document.getElementById('recovery-new-password').value;
      try {
        const data = await fetch('/api/auth/reset-with-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, token, newPassword }),
        }).then(r => r.json());
        if (data.ok) {
          alert('Password reset successfully. You can now log in.');
          recoveryScreen.classList.add('hidden');
          loginContainer.classList.remove('hidden');
          document.getElementById('username').value = username;
        } else {
          alert(data.error || 'Recovery failed');
        }
      } catch (err) {
        alert('Recovery failed: ' + err.message);
      }
    });
  }

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

    socket.on('edit_message', (data) => {
      if (data.channel_id === currentChannel) {
        const el = document.querySelector(`[data-message-id="${data.id}"]`);
        if (el) {
          const bodyEl = el.querySelector('.message-body');
          if (bodyEl) bodyEl.textContent = data.body;
        }
      }
    });

    socket.on('new_message', (msg) => {
      // Always update main chat feed if channel matches (even if viewing another panel)
      if (msg.channel_id === currentChannel) {
        const chatView = document.getElementById('chat-view');
        if (chatView) {
          appendMessage(msg);
          // Only auto-scroll if chat is the active view
          if (currentView === 'chat') scrollToBottom();
        }
      }
      // Also update split-panel chat if it's showing this channel
      if (msg.channel_id === currentChannel) {
        const splitContainer = document.getElementById('split-message-container');
        if (splitContainer && splitRightView === 'chat') {
          const div = document.createElement('div');
          div.className = 'message';
          div.style.marginBottom = '0.75rem';
          div.innerHTML = `
            <div style="font-size:0.75rem;opacity:0.5;margin-bottom:2px;">
              <strong>${escapeHtml(msg.from_user || '')}</strong>
              <span style="margin-left:0.5rem;">${new Date(msg.created_at || Date.now()).toLocaleTimeString()}</span>
            </div>
            <div class="markdown-body">${typeof marked !== 'undefined' ? marked.parse(msg.body || '') : escapeHtml(msg.body || '')}</div>
          `;
          splitContainer.appendChild(div);
          splitContainer.scrollTop = splitContainer.scrollHeight;
        }
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

    socket.on('approval_update', () => {
      if (currentView === 'approvals') {
        loadApprovals();
      }
    });

    // Reconnect handling — re-join channel on reconnect
    socket.on('disconnect', (reason) => {
      console.warn('[Darkhan] Socket disconnected:', reason);
    });
    socket.on('reconnect', () => {
      console.log('[Darkhan] Socket reconnected, rejoining channel:', currentChannel);
      socket.emit('join_channel', currentChannel);
      // Reload messages to catch anything missed while disconnected
      if (currentView === 'chat') loadMessages();
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
    // In split mode, new views go into the left panel, not main-content directly
    const viewParent = splitMode
      ? (document.getElementById('split-left-panel') || document.getElementById('main-content'))
      : document.getElementById('main-content');

    const chatView = document.getElementById('chat-view');
    // Lazily create dashboard/task views if they don't exist
    let dashView = document.getElementById('dashboard-view');
    let taskView = document.getElementById('tasks-view');

    if (!dashView) {
      dashView = document.createElement('div');
      dashView.id = 'dashboard-view';
      dashView.className = 'view hidden';
      dashView.innerHTML = '<header class="channel-header"><h2>Dashboard</h2></header><div id="dashboard-content" class="content-area"><p>Loading...</p></div>';
      viewParent.appendChild(dashView);
    }
    if (!taskView) {
      taskView = document.createElement('div');
      taskView.id = 'tasks-view';
      taskView.className = 'view hidden';
      taskView.innerHTML = '<header class="channel-header"><h2>Tasks</h2></header><div id="tasks-content" class="content-area"><p>Loading...</p></div>';
      viewParent.appendChild(taskView);
    }

    // Approvals view
    let appView = document.getElementById("approvals-view");
    if (!appView) {
      appView = document.createElement("div");
      appView.id = "approvals-view";
      appView.className = "view hidden";
      appView.innerHTML = '<header class="channel-header"><h2>Approvals</h2></header><div id="approvals-content" class="content-area"><p>Loading...</p></div>';
      viewParent.appendChild(appView);
    }

    // Workers view
    let workView = document.getElementById('workers-view');
    if (!workView) {
      workView = document.createElement('div');
      workView.id = 'workers-view';
      workView.className = 'view hidden';
      workView.innerHTML = '<header class="channel-header"><h2>Workers</h2></header><div id="workers-content" class="content-area"><p>Loading...</p></div>';
      viewParent.appendChild(workView);
    }

    // Costs view
    let costView = document.getElementById('costs-view');
    if (!costView) {
      costView = document.createElement('div');
      costView.id = 'costs-view';
      costView.className = 'view hidden';
      costView.innerHTML = '<header class="channel-header"><h2>Costs</h2></header><div id="costs-content" class="content-area"><p>Loading...</p></div>';
      viewParent.appendChild(costView);
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
      viewParent.appendChild(docsView);
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
            <input type="password" id="pin-new" placeholder="New PIN (8+ chars)" required minlength="8" style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:200px;">
            <input type="password" id="pin-confirm" placeholder="Confirm PIN" required style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:200px;">
            <button type="submit" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;width:fit-content;">Set Lockdown PIN</button>
            <div id="pin-status" style="font-size:0.9rem;"></div>
          </form>

          <h3 style="margin-bottom:1rem;">Integrity Baseline</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">After making legitimate code changes, reset the integrity baseline so Darkhan recognizes the current files as trusted.</p>
          <button id="reset-baseline-btn" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">Reset Integrity Baseline</button>
          <div id="baseline-status" style="font-size:0.9rem;margin-top:0.5rem;"></div>

          <h3 style="margin-top:2rem;margin-bottom:1rem;">Password Recovery</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Generate a one-time recovery token for a user who forgot their password. Token expires in 1 hour.</p>
          <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;">
            <select id="recovery-user-select" style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);"></select>
            <button id="generate-recovery-btn" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">Generate Token</button>
          </div>
          <div id="recovery-token-display" style="font-size:0.9rem;margin-top:0.5rem;"></div>

          <h3 style="margin-top:2rem;margin-bottom:1rem;">Agent Execution Tier</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Controls how much autonomy agents have when using tools. Security-sensitive actions (credentials, auth, admin) always require your approval regardless of tier.</p>
          <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem;">
            <select id="execution-tier-select" style="padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);min-width:200px;">
              <option value="supervised">Supervised — approve all writes</option>
              <option value="operational">Operational — approve security only</option>
              <option value="autonomous">Autonomous — approve security only (max freedom)</option>
            </select>
            <button id="set-tier-btn" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">Set</button>
          </div>
          <div id="tier-status" style="font-size:0.9rem;margin-top:0.25rem;"></div>
          <div style="font-size:0.8rem;opacity:0.6;margin-top:0.75rem;">
            <strong>Supervised:</strong> Reads are free. All file writes, edits, and commands need your OK.<br>
            <strong>Operational:</strong> Code edits, file writes, service restarts are pre-approved. Great for active dev sessions.<br>
            <strong>Autonomous:</strong> Everything runs freely except credential access, auth changes, and admin ops.
          </div>

          <h3 style="margin-top:2rem;margin-bottom:1rem;">Lead Agent Session</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Controls how the lead agent (Claude, Codex, etc.) manages session context. These apply to any LLM connected as the primary agent.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;max-width:400px;margin-bottom:0.5rem;">
            <label style="font-size:0.85rem;">Session cycle (messages):</label>
            <input type="number" id="la-cycle" min="10" max="500" style="padding:0.3rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:80px;">
            <label style="font-size:0.85rem;">Context window (messages):</label>
            <input type="number" id="la-context" min="10" max="500" style="padding:0.3rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:80px;">
            <label style="font-size:0.85rem;">Transcript depth (days):</label>
            <input type="number" id="la-transcript-days" min="1" max="7" style="padding:0.3rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:80px;">
            <label style="font-size:0.85rem;">State file maintenance:</label>
            <input type="checkbox" id="la-state-maint" style="width:20px;height:20px;">
            <label style="font-size:0.85rem;">Startup protocol:</label>
            <input type="checkbox" id="la-startup" style="width:20px;height:20px;">
            <label style="font-size:0.85rem;">State file path:</label>
            <input type="text" id="la-state-file" style="padding:0.3rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);width:180px;font-size:0.8rem;">
          </div>
          <button id="save-lead-agent-btn" style="padding:0.5rem 1rem;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;">Save</button>
          <div id="la-status" style="font-size:0.9rem;margin-top:0.25rem;"></div>

          <h3 style="margin-top:2rem;margin-bottom:1rem;">Manual Lockdown</h3>
          <p style="font-size:0.85rem;opacity:0.7;margin-bottom:0.75rem;">Immediately halt all agent operations. Only you can unlock.</p>
          <button id="manual-lockdown-btn" style="padding:0.5rem 1rem;background:#c0392b;color:white;border:none;border-radius:4px;cursor:pointer;">Trigger Lockdown</button>
        </div>
      `;
      viewParent.appendChild(settingsView);

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

      document.getElementById('reset-baseline-btn').addEventListener('click', async () => {
        if (!confirm('Reset integrity baseline? This tells Darkhan the current files are trusted.')) return;
        const status = document.getElementById('baseline-status');
        try {
          await api('POST', '/security/reset-baseline');
          status.textContent = 'Baseline reset successfully'; status.style.color = '#27ae60';
        } catch (err) { status.textContent = err.message; status.style.color = '#e74c3c'; }
      });

      document.getElementById('manual-lockdown-btn').addEventListener('click', async () => {
        if (!confirm('Trigger lockdown? All agent operations will be halted until you unlock.')) return;
        try {
          await api('POST', '/security/lockdown', { reason: 'Manual lockdown by admin' });
          alert('Lockdown activated');
          checkLockdownStatus();
        } catch (err) { alert('Lockdown failed: ' + err.message); }
      });

      // Recovery token generation
      // Populate user dropdown with human users
      (async () => {
        try {
          const data = await api('GET', '/team');
          const select = document.getElementById('recovery-user-select');
          (data.members || []).filter(m => m.type === 'human').forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `${m.display_name || m.username} (${m.id})`;
            select.appendChild(opt);
          });
        } catch (e) { console.warn('Could not load team for recovery:', e); }
      })();

      document.getElementById('generate-recovery-btn').addEventListener('click', async () => {
        const userId = document.getElementById('recovery-user-select').value;
        const display = document.getElementById('recovery-token-display');
        if (!userId) { display.textContent = 'Select a user first'; display.style.color = '#e74c3c'; return; }
        try {
          const data = await api('POST', '/auth/generate-recovery', { userId });
          display.innerHTML = `<strong style="color:#27ae60;">Token for ${data.username}:</strong><br><code style="font-size:1.1rem;user-select:all;background:var(--bg-primary);padding:0.3rem 0.6rem;border-radius:4px;">${data.token}</code><br><span style="font-size:0.8rem;opacity:0.7;">Expires: ${new Date(data.expiresAt).toLocaleString()}</span>`;
        } catch (err) { display.textContent = err.message; display.style.color = '#e74c3c'; }
      });

      // Execution tier — load current value and wire up change handler
      (async () => {
        try {
          const data = await api('GET', '/auth/execution-tier');
          const select = document.getElementById('execution-tier-select');
          if (select && data.executionTier) select.value = data.executionTier;
        } catch (e) { console.warn('Could not load execution tier:', e); }
      })();

      document.getElementById('set-tier-btn').addEventListener('click', async () => {
        const select = document.getElementById('execution-tier-select');
        const status = document.getElementById('tier-status');
        const tier = select.value;
        try {
          await api('POST', '/auth/execution-tier', { tier });
          status.textContent = `Execution tier set to "${tier}". New Claude sessions will use this tier.`;
          status.style.color = '#27ae60';
        } catch (err) { status.textContent = err.message; status.style.color = '#e74c3c'; }
      });

      // Lead agent settings — load current values and wire up save
      (async () => {
        try {
          const data = await api('GET', '/context/settings');
          document.getElementById('la-cycle').value = data.sessionCycleMessages || 50;
          document.getElementById('la-context').value = data.channelContextMessages || 100;
          document.getElementById('la-transcript-days').value = data.transcriptReadDays || 2;
          document.getElementById('la-state-maint').checked = data.stateMaintenance !== false;
          document.getElementById('la-startup').checked = data.startupProtocol !== false;
          document.getElementById('la-state-file').value = data.stateFile || '';
        } catch (e) { console.warn('Could not load lead agent settings:', e); }
      })();

      document.getElementById('save-lead-agent-btn').addEventListener('click', async () => {
        const status = document.getElementById('la-status');
        try {
          await api('POST', '/context/settings', {
            sessionCycleMessages: parseInt(document.getElementById('la-cycle').value),
            channelContextMessages: parseInt(document.getElementById('la-context').value),
            transcriptReadDays: parseInt(document.getElementById('la-transcript-days').value),
            stateMaintenance: document.getElementById('la-state-maint').checked,
            startupProtocol: document.getElementById('la-startup').checked,
            stateFile: document.getElementById('la-state-file').value || null,
          });
          status.textContent = 'Lead agent settings saved. Takes effect on next session.';
          status.style.color = '#27ae60';
        } catch (err) { status.textContent = err.message; status.style.color = '#e74c3c'; }
      });
    }

    // Terminal view (Claude Code)
    let termView = document.getElementById('terminal-view');
    if (!termView) {
      termView = document.createElement('div');
      termView.id = 'terminal-view';
      termView.className = 'view hidden';
      termView.innerHTML = `
        <header class="channel-header" style="display:flex;align-items:center;justify-content:space-between;">
          <h2>Terminal</h2>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <span id="terminal-status" style="font-size:0.8rem;color:var(--text-muted);">Disconnected</span>
            <select id="terminal-mode" style="padding:0.3rem 0.5rem;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);font-size:0.85rem;">
              <option value="claude">Claude Code</option>
              <option value="shell">Shell</option>
            </select>
            <button id="terminal-spawn-btn" style="padding:0.3rem 0.8rem;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:0.85rem;">Start</button>
            <button id="terminal-kill-btn" style="padding:0.3rem 0.8rem;background:var(--danger, #c0392b);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:0.85rem;display:none;">End</button>
            <button id="terminal-popout-btn" style="padding:0.3rem 0.8rem;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;font-size:0.85rem;" title="Pop out to separate window">&#8599;</button>
          </div>
        </header>
        <div id="terminal-container" style="flex:1;background:#0d1117;padding:4px;overflow:hidden;"></div>
      `;
      viewParent.appendChild(termView);
      document.getElementById('terminal-spawn-btn').addEventListener('click', spawnTerminal);
      document.getElementById('terminal-kill-btn').addEventListener('click', killTerminal);
      document.getElementById('terminal-popout-btn').addEventListener('click', popoutTerminal);
    }

    // Check lockdown status when settings view is shown
    if (view === 'settings') checkLockdownStatus();
    if (view === 'terminal') initTerminal();

    chatView.classList.toggle('hidden', view !== 'chat');
    dashView.classList.toggle('hidden', view !== 'dashboard');
    taskView.classList.toggle('hidden', view !== 'tasks');
    appView.classList.toggle('hidden', view !== 'approvals');
    workView.classList.toggle('hidden', view !== 'workers');
    costView.classList.toggle('hidden', view !== 'costs');
    if (settingsView) settingsView.classList.toggle('hidden', view !== 'settings');
    if (docsView) docsView.classList.toggle('hidden', view !== 'docs');
    if (termView) termView.classList.toggle('hidden', view !== 'terminal');
    // Override display for docs and terminal (need flex, not block)
    if (view === 'docs' && docsView) docsView.style.display = 'flex';
    else if (docsView) docsView.style.display = 'none';
    if (view === 'terminal' && termView) termView.style.display = 'flex';
    else if (termView) termView.style.display = 'none';
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
    const time = new Date(utcTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: userTimezone });
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

      // Post the user's question as a regular message first
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
            <span class="msg-user">darkhan</span>
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
          from_user: 'darkhan',
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
      // Role labels populated from team config — no hardcoded roles
      const roleLabels = {};
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
      // Load pending approvals
      const pending = await api('GET', '/approvals?status=pending');
      // Load history (approved + denied, most recent 50)
      const history = await api('GET', '/approvals?limit=50');
      const historyItems = (history.approvals || []).filter(a => a.status !== 'pending');

      let html = '<h3 style="margin:0 0 1rem 0;">Pending Approvals</h3>';

      if (!pending.approvals || pending.approvals.length === 0) {
        html += '<p class="empty" style="margin-bottom:2rem;">No pending approvals.</p>';
      } else {
        html += pending.approvals.map(a => `
          <div class="task-card status-${a.status}" style="margin-bottom:0.75rem;">
            <div class="task-header">
              <strong>${escapeHtml(a.action_type)}</strong>
              <span class="task-priority" style="background:var(--accent);color:#fff;padding:0.15rem 0.5rem;border-radius:3px;font-size:0.75rem;">PENDING</span>
            </div>
            <div class="task-meta">Requested by: <strong>${escapeHtml(a.requested_by)}</strong> | ${new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').toLocaleString('en-US', { timeZone: userTimezone })} ET</div>
            <div class="task-desc" style="margin:0.5rem 0;white-space:pre-wrap;">${escapeHtml(a.action_detail)}</div>
            <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
              <button onclick="window._approveRequest('${a.id}')" style="background:var(--success, #27ae60);color:#fff;border:none;padding:0.4rem 1rem;border-radius:var(--radius);cursor:pointer;font-weight:bold;">Approve</button>
              <button onclick="window._denyRequest('${a.id}')" style="background:var(--danger, #c0392b);color:#fff;border:none;padding:0.4rem 1rem;border-radius:var(--radius);cursor:pointer;font-weight:bold;">Deny</button>
            </div>
          </div>
        `).join('');
      }

      html += '<h3 style="margin:1.5rem 0 1rem 0;">History</h3>';

      if (historyItems.length === 0) {
        html += '<p class="empty">No approval history yet.</p>';
      } else {
        html += historyItems.map(a => {
          const statusColor = a.status === 'approved' ? 'var(--success, #27ae60)' : 'var(--danger, #c0392b)';
          const statusLabel = a.status.toUpperCase();
          const reviewedAt = a.reviewed_at ? new Date(a.reviewed_at.endsWith('Z') ? a.reviewed_at : a.reviewed_at + 'Z').toLocaleString('en-US', { timeZone: userTimezone }) : 'unknown';
          return `
            <div class="task-card" style="margin-bottom:0.5rem;opacity:0.8;">
              <div class="task-header">
                <strong>${escapeHtml(a.action_type)}</strong>
                <span style="background:${statusColor};color:#fff;padding:0.15rem 0.5rem;border-radius:3px;font-size:0.75rem;">${statusLabel}</span>
              </div>
              <div class="task-meta">Requested by: ${escapeHtml(a.requested_by)} | Reviewed by: ${escapeHtml(a.reviewed_by || '?')} | ${reviewedAt} ET</div>
              <div class="task-desc" style="font-size:0.85rem;opacity:0.7;">${escapeHtml(a.action_detail)}</div>
            </div>
          `;
        }).join('');
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<p class="error">Failed to load approvals: ${err.message}</p>`;
    }
  }

  // Approval action handlers — use the new POST endpoints (session auth, human admin only)
  window._approveRequest = async function(id) {
    if (!confirm('Approve this request?')) return;
    try {
      await api('POST', `/approvals/${id}/approve`);
      loadApprovals();
    } catch (err) {
      alert('Approve failed: ' + err.message);
    }
  };

  window._denyRequest = async function(id) {
    if (!confirm('Deny this request?')) return;
    try {
      await api('POST', `/approvals/${id}/deny`);
      loadApprovals();
    } catch (err) {
      alert('Deny failed: ' + err.message);
    }
  };

  // Legacy handler kept for backward compat
  window.handleApproval = async function(id, status) {
    try {
      await api('PATCH', `/approvals/${id}`, { status });
      loadApprovals();
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
      // Built-in entries at the top of the tree
      const builtInHtml = `
        <div style="margin-bottom:0.75rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border);">
          <div class="tree-file" data-path="_help" onclick="window._openHelp()" style="cursor:pointer;padding:3px 4px;border-radius:3px;display:flex;align-items:center;gap:4px;font-weight:bold;">
            <span style="font-size:0.8rem;">?</span> Help &amp; Troubleshooting
          </div>
          <div class="tree-file" data-path="_activity" onclick="window._openActivityLog()" style="cursor:pointer;padding:3px 4px;border-radius:3px;display:flex;align-items:center;gap:4px;font-weight:bold;">
            <span style="font-size:0.8rem;">&#9776;</span> Activity Log
          </div>
        </div>
      `;
      treeContainer.innerHTML = builtInHtml + renderTree(data.tree, 0);
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

  // --- Help Panel ---
  window._openHelp = function() {
    const contentContainer = document.getElementById('docs-rendered');
    const breadcrumb = document.getElementById('docs-breadcrumb');
    if (!contentContainer) return;
    docsCurrentPath = '_help';

    // Highlight
    document.querySelectorAll('.tree-file').forEach(el => el.style.background = '');
    const el = document.querySelector('.tree-file[data-path="_help"]');
    if (el) el.style.background = 'var(--bg-hover, rgba(255,255,255,0.1))';

    breadcrumb.innerHTML = '<span style="opacity:0.6;">Help &amp; Troubleshooting</span>';
    contentContainer.innerHTML = `
      <div style="line-height:1.7;max-width:720px;">
        <h1 style="margin-bottom:1rem;">Darkhan Help</h1>

        <h2>Quick Start</h2>
        <ul>
          <li><strong>Chat</strong> — Talk to Claude or your agents in #command. Messages starting with <code>@claude</code> go to the unified Claude session.</li>
          <li><strong>Terminal</strong> — Full Claude Code session in the browser. Click "Start Session" to spawn. Terminal and chat share the same Claude instance and context.</li>
          <li><strong>Split View</strong> — Click the split button (&#9707;) in any channel header to open a side-by-side view. Select "Terminal" in the right panel to watch Claude's tool calls and output in real-time while chatting.</li>
          <li><strong>Docs</strong> — Browse and edit files in your vault (knowledge base). Markdown files render automatically.</li>
        </ul>

        <h2>Slash Commands</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 8px;border-bottom:1px solid var(--border);"><code>/status</code></td><td style="padding:4px 8px;border-bottom:1px solid var(--border);">Show worker status, Claude session state, review gate status</td></tr>
          <tr><td style="padding:4px 8px;border-bottom:1px solid var(--border);"><code>/review-gate on|off|status</code></td><td style="padding:4px 8px;border-bottom:1px solid var(--border);">Toggle the output review gate (local LLM checks Claude's responses)</td></tr>
          <tr><td style="padding:4px 8px;border-bottom:1px solid var(--border);"><code>/help</code></td><td style="padding:4px 8px;border-bottom:1px solid var(--border);">List available commands in chat</td></tr>
        </table>

        <h2>Terminal</h2>
        <ul>
          <li><strong>Claude Code mode</strong> — Unified session, shared context with chat. What you discuss in chat, Claude remembers in terminal and vice versa.</li>
          <li><strong>Shell mode</strong> — Standard bash/zsh terminal for system commands.</li>
          <li><strong>Pop-out</strong> — Click &#8599; to open terminal in a separate window (multi-monitor).</li>
          <li><strong>Split observer</strong> — Use split view to watch Claude's activity without leaving chat. Both panels can send input.</li>
          <li><strong>Session persistence</strong> — 120-second grace period on page refresh. Sessions survive server restarts (up to 8 hours).</li>
        </ul>

        <h2>Security</h2>
        <ul>
          <li><strong>Lockdown</strong> — Triggered automatically by security events. All agent traffic stops. Unlock with your PIN in Settings.</li>
          <li><strong>Break-glass</strong> — If locked out, run <code>node break-glass.js</code> from the server terminal (requires interactive TTY + PIN).</li>
          <li><strong>Activity log</strong> — Every action is SHA-256 hash-chained. View it from the "Activity Log" entry in this Docs panel.</li>
          <li><strong>Claim verification</strong> — Every agent message is automatically checked against evidence. Look for verification tags in message metadata.</li>
        </ul>

        <h2>Troubleshooting</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>Terminal won't start</strong></td>
            <td style="padding:8px;">Check that Ollama is running (<code>ollama list</code>). Check server logs for Socket.IO errors. Try refreshing the page.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>Stream timeout</strong></td>
            <td style="padding:8px;">Turns longer than 5 minutes are cut off. The session recovers automatically — just send your next message. If frequent, the task may be too large for a single turn.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>Agent shows red/grey</strong></td>
            <td style="padding:8px;">Red = heartbeat missed (agent may have crashed). Grey = no data yet. Check Workers view for details. Restart server if needed.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>System locked down</strong></td>
            <td style="padding:8px;">Go to Settings, enter your lockdown PIN to unlock. If you forgot your PIN, use <code>node break-glass.js</code> on the server.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>Password forgotten</strong></td>
            <td style="padding:8px;">An admin can generate a one-time recovery token from Settings. No email required.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>LLM budget exceeded</strong></td>
            <td style="padding:8px;">Check Costs view for per-agent spending. Adjust <code>rateLimits.requestsPerDay</code> in <code>darkhan.config.json</code>. Set to <code>0</code> for unlimited.</td>
          </tr>
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;vertical-align:top;"><strong>Clean install</strong></td>
            <td style="padding:8px;">Delete <code>server/db/</code> and run <code>node setup.js</code> again. The wizard handles everything.</td>
          </tr>
        </table>

        <h2>Architecture</h2>
        <ul>
          <li><strong>Server</strong> — Node.js + Express + SQLite + Socket.IO</li>
          <li><strong>Local LLM</strong> — Ollama (Qwen 2.5 14B default, $0/day)</li>
          <li><strong>Cloud LLM</strong> — Gemini, Anthropic Claude, OpenAI GPT (pay-per-use)</li>
          <li><strong>Security</strong> — Two-LLM consensus on all external messages, immutable hash chain audit trail, credential isolation, identity enforcement</li>
          <li><strong>Evidence</strong> — Action-Evidence Protocol (15-verb vocabulary), Observation-Evidence Protocol (18 observation types), automatic privilege boundary detection, cross-provider claim verification</li>
        </ul>

        <p style="margin-top:2rem;opacity:0.5;font-size:0.85rem;">For full documentation, see README.md, SETUP.md, WORKER-CONTRACT.md, and SECURITY.md in the project root.</p>
      </div>
    `;
  };

  // --- Activity Log Viewer ---
  window._openActivityLog = async function() {
    const contentContainer = document.getElementById('docs-rendered');
    const breadcrumb = document.getElementById('docs-breadcrumb');
    if (!contentContainer) return;
    docsCurrentPath = '_activity';

    // Highlight
    document.querySelectorAll('.tree-file').forEach(el => el.style.background = '');
    const el = document.querySelector('.tree-file[data-path="_activity"]');
    if (el) el.style.background = 'var(--bg-hover, rgba(255,255,255,0.1))';

    breadcrumb.innerHTML = `
      <span style="opacity:0.6;">Activity Log</span>
      <span style="float:right;display:flex;gap:0.5rem;">
        <button onclick="window._openActivityLog()" style="background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:0.2rem 0.6rem;border-radius:var(--radius);cursor:pointer;font-size:0.8rem;">Refresh</button>
        <button onclick="window._verifyChain()" style="background:var(--accent);color:#fff;border:none;padding:0.2rem 0.6rem;border-radius:var(--radius);cursor:pointer;font-size:0.8rem;">Verify Chain</button>
      </span>
    `;
    contentContainer.innerHTML = '<p style="opacity:0.5;">Loading activity log...</p>';

    try {
      const data = await api('GET', '/activity?limit=200');
      const events = data.events || data || [];

      if (events.length === 0) {
        contentContainer.innerHTML = '<p>No activity log entries found.</p>';
        return;
      }

      let html = `
        <div style="margin-bottom:1rem;">
          <input type="text" id="activity-filter" placeholder="Filter by actor, action, or target..." oninput="window._filterActivity(this.value)"
            style="width:100%;padding:0.4rem 0.8rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.85rem;">
        </div>
        <div id="activity-chain-status" style="margin-bottom:1rem;"></div>
        <table id="activity-table" style="width:100%;border-collapse:collapse;font-size:0.82rem;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);text-align:left;">
              <th style="padding:6px 8px;width:140px;">Time</th>
              <th style="padding:6px 8px;width:140px;">Actor</th>
              <th style="padding:6px 8px;width:180px;">Action</th>
              <th style="padding:6px 8px;">Target / Details</th>
            </tr>
          </thead>
          <tbody>
      `;

      for (const e of events) {
        const time = e.created_at ? new Date(e.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
        const date = e.created_at ? new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const actionColor = _activityColor(e.action);
        const details = e.details ? e.details.substring(0, 120) : '';
        const target = e.target || '';
        html += `<tr class="activity-row" data-search="${(e.actor || '').toLowerCase()} ${(e.action || '').toLowerCase()} ${(target).toLowerCase()}" style="border-bottom:1px solid var(--border);">
          <td style="padding:4px 8px;opacity:0.7;white-space:nowrap;" title="${e.created_at || ''}">${date} ${time}</td>
          <td style="padding:4px 8px;"><code>${escapeHtml(e.actor || '')}</code></td>
          <td style="padding:4px 8px;color:${actionColor};"><code>${escapeHtml(e.action || '')}</code></td>
          <td style="padding:4px 8px;opacity:0.8;word-break:break-all;" title="${escapeHtml(details)}">${escapeHtml(target)}${details ? ' — ' + escapeHtml(details) : ''}</td>
        </tr>`;
      }

      html += '</tbody></table>';
      contentContainer.innerHTML = html;
    } catch (err) {
      contentContainer.innerHTML = `<p class="error">Failed to load activity log: ${err.message}</p>`;
    }
  };

  function _activityColor(action) {
    if (!action) return 'var(--text-primary)';
    if (action.includes('error') || action.includes('failed') || action.includes('denied') || action.includes('injection') || action.includes('threat')) return 'var(--danger, #e74c3c)';
    if (action.includes('completed') || action.includes('granted') || action.includes('verified')) return 'var(--success, #27ae60)';
    if (action.includes('started') || action.includes('llm_call') || action.includes('tool_call')) return 'var(--accent, #e94560)';
    if (action.includes('message') || action.includes('post')) return 'var(--info, #3498db)';
    return 'var(--text-primary)';
  }

  window._filterActivity = function(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.activity-row').forEach(row => {
      const search = row.getAttribute('data-search') || '';
      row.style.display = !q || search.includes(q) ? '' : 'none';
    });
  };

  window._verifyChain = async function() {
    const statusEl = document.getElementById('activity-chain-status');
    if (!statusEl) return;
    statusEl.innerHTML = '<span style="opacity:0.5;">Verifying hash chain integrity...</span>';
    try {
      const result = await api('GET', '/activity/verify');
      if (result.valid) {
        statusEl.innerHTML = `<span style="color:var(--success, #27ae60);font-weight:bold;">Chain verified — ${result.entries || 'all'} entries, integrity intact.</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:var(--danger, #e74c3c);font-weight:bold;">CHAIN BROKEN — ${result.error || 'integrity violation detected'}. Entry #${result.brokenAt || '?'}</span>`;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--danger);">Verification failed: ${err.message}</span>`;
    }
  };

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

  // --- Split Screen & Popout ---

  // Available views for the split panel selector
  const SPLIT_VIEW_OPTIONS = [
    { value: 'chat', label: 'Chat' },
    { value: 'terminal', label: 'Terminal' },
    { value: 'docs', label: 'Docs' },
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'tasks', label: 'Tasks' },
    { value: 'workers', label: 'Workers' },
    { value: 'costs', label: 'Costs' },
    { value: 'approvals', label: 'Approvals' },
  ];

  function addViewToolbarButtons() {
    // Add split + popout buttons to all channel headers after they're created
    document.querySelectorAll('.channel-header').forEach(header => {
      if (header.querySelector('.view-toolbar-btn')) return; // already added
      const btnGroup = document.createElement('div');
      btnGroup.style.cssText = 'display:flex;gap:4px;margin-left:auto;';
      btnGroup.innerHTML = `
        <button class="view-toolbar-btn" onclick="window._toggleSplit()" title="Split screen">&#9707;</button>
        <button class="view-toolbar-btn" onclick="window._popoutCurrentView()" title="Pop out">&#8599;</button>
      `;
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.appendChild(btnGroup);
    });
  }

  window._toggleSplit = function() {
    const main = document.getElementById('main-content');
    if (splitMode) {
      // Exit split mode
      splitMode = false;
      main.classList.remove('split-mode');
      cleanupSplitTerminal();
      // Move views back out of the left panel wrapper into main-content
      const leftPanel = document.getElementById('split-left-panel');
      if (leftPanel) {
        const views = Array.from(leftPanel.querySelectorAll('.view'));
        views.forEach(v => main.appendChild(v));
        leftPanel.remove();
      }
      const rightPanel = document.getElementById('split-right-panel');
      if (rightPanel) rightPanel.remove();
      // Re-fit terminal and scroll chat after layout restore
      setTimeout(() => {
        if (fitAddon) fitAddon.fit();
        scrollToBottom(true);
      }, 150);
      return;
    }

    // Enter split mode
    splitMode = true;
    main.classList.add('split-mode');

    // Wrap existing views in left panel
    let leftPanel = document.getElementById('split-left-panel');
    if (!leftPanel) {
      leftPanel = document.createElement('div');
      leftPanel.id = 'split-left-panel';
      leftPanel.className = 'split-panel';
      // Move all existing views into the left panel
      const views = Array.from(main.querySelectorAll('.view'));
      views.forEach(v => leftPanel.appendChild(v));
      main.insertBefore(leftPanel, main.firstChild);
    }

    // Create right panel
    let rightPanel = document.getElementById('split-right-panel');
    if (!rightPanel) {
      rightPanel = document.createElement('div');
      rightPanel.id = 'split-right-panel';
      rightPanel.className = 'split-panel';

      // Panel selector
      const selector = document.createElement('div');
      selector.className = 'split-panel-selector';
      selector.innerHTML = `
        <span style="opacity:0.6;">Right panel:</span>
        <select id="split-right-select">
          ${SPLIT_VIEW_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button class="view-toolbar-btn" onclick="window._popoutSplitRight()" title="Pop out right panel">&#8599;</button>
        <button class="view-toolbar-btn" onclick="window._toggleSplit()" title="Close split">&#10005;</button>
      `;
      rightPanel.appendChild(selector);

      // Content area for right panel
      const content = document.createElement('div');
      content.id = 'split-right-content';
      content.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';
      rightPanel.appendChild(content);

      main.appendChild(rightPanel);

      // Default to terminal if current view is chat, or chat if current is terminal
      const defaultRight = currentView === 'chat' ? 'terminal' : 'chat';
      document.getElementById('split-right-select').value = defaultRight;
      loadSplitRightView(defaultRight);

      document.getElementById('split-right-select').addEventListener('change', (e) => {
        loadSplitRightView(e.target.value);
      });
    }
    // Re-fit terminals after split layout settles
    setTimeout(() => {
      if (fitAddon) fitAddon.fit();
      if (splitFitAddon) splitFitAddon.fit();
    }, 150);
  };

  function loadSplitRightView(viewName) {
    // Clean up split terminal if switching away from it
    if (splitRightView === 'terminal' && viewName !== 'terminal') {
      cleanupSplitTerminal();
    }
    splitRightView = viewName;
    const container = document.getElementById('split-right-content');
    if (!container) return;
    container.innerHTML = '';

    if (viewName === 'chat') {
      // Clone a simple chat view for the right panel
      const chatDiv = document.createElement('div');
      chatDiv.className = 'view';
      chatDiv.style.cssText = 'flex:1;display:flex;flex-direction:column;';
      chatDiv.innerHTML = `
        <header class="channel-header">
          <h2 id="split-channel-name">#command</h2>
        </header>
        <div id="split-message-container" class="message-feed" style="flex:1;overflow-y:auto;padding:1rem;"></div>
        <footer class="message-input-area" style="padding:0.5rem;">
          <form id="split-message-form" style="display:flex;gap:0.5rem;">
            <input type="text" id="split-message-input" placeholder="Message..." autocomplete="off" style="flex:1;padding:0.5rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);">
            <button type="submit" style="padding:0.5rem 1rem;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;">Send</button>
          </form>
        </footer>
      `;
      container.appendChild(chatDiv);
      // Load messages for the current channel
      loadSplitChat(currentChannel);
      document.getElementById('split-message-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('split-message-input');
        if (input.value.trim()) {
          sendMessage(currentChannel, input.value.trim());
          input.value = '';
        }
      });
    } else if (viewName === 'terminal') {
      const termDiv = document.createElement('div');
      termDiv.className = 'view';
      termDiv.style.cssText = 'flex:1;display:flex;flex-direction:column;';
      termDiv.innerHTML = `
        <header class="channel-header" style="display:flex;align-items:center;justify-content:space-between;">
          <h2>Terminal</h2>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <span id="split-terminal-status" style="font-size:0.8rem;color:var(--text-muted);">Disconnected</span>
            <button id="split-terminal-connect-btn" class="view-toolbar-btn" onclick="window._connectSplitTerminal()">Connect</button>
            <button id="split-terminal-disconnect-btn" class="view-toolbar-btn" onclick="window._disconnectSplitTerminal()" style="display:none;">Disconnect</button>
          </div>
        </header>
        <div id="split-terminal-container" style="flex:1;background:#0d1117;padding:4px;overflow:hidden;"></div>
      `;
      container.appendChild(termDiv);
      initSplitTerminal();
      // Auto-connect to the unified session
      setTimeout(() => window._connectSplitTerminal(), 200);
    } else {
      // Generic view — fetch data via API and render directly
      const div = document.createElement('div');
      div.className = 'view';
      div.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:auto;';
      const label = viewName.charAt(0).toUpperCase() + viewName.slice(1);
      div.innerHTML = `
        <header class="channel-header"><h2>${label}</h2></header>
        <div id="split-generic-content" class="content-area" style="flex:1;overflow-y:auto;padding:1rem;"><p>Loading...</p></div>
      `;
      container.appendChild(div);
      loadSplitGenericView(viewName);
    }
  }

  async function loadSplitGenericView(viewName) {
    const el = document.getElementById('split-generic-content');
    if (!el) return;

    const endpoints = {
      dashboard: '/health/status',
      tasks: '/tasks',
      workers: '/workers',
      costs: '/costs/daily',
      approvals: '/tasks?type=approval',
      docs: '/vault/tree',
    };

    const endpoint = endpoints[viewName];
    if (!endpoint) { el.innerHTML = '<p>View not available in split mode.</p>'; return; }

    try {
      const data = await api('GET', endpoint);

      if (viewName === 'dashboard') {
        const s = data;
        el.innerHTML = `
          <div style="display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">
            <div style="background:var(--bg-secondary);padding:1rem;border-radius:var(--radius);border:1px solid var(--border);">
              <div style="font-size:0.75rem;opacity:0.6;text-transform:uppercase;">Status</div>
              <div style="font-size:1.5rem;font-weight:bold;color:${s.lockdown ? 'var(--danger)' : 'var(--success)'};">${s.lockdown ? 'LOCKDOWN' : 'Operational'}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:1rem;border-radius:var(--radius);border:1px solid var(--border);">
              <div style="font-size:0.75rem;opacity:0.6;text-transform:uppercase;">Uptime</div>
              <div style="font-size:1.5rem;font-weight:bold;">${s.uptime ? Math.floor(s.uptime/3600) + 'h' : 'N/A'}</div>
            </div>
            <div style="background:var(--bg-secondary);padding:1rem;border-radius:var(--radius);border:1px solid var(--border);">
              <div style="font-size:0.75rem;opacity:0.6;text-transform:uppercase;">Workers</div>
              <div style="font-size:1.5rem;font-weight:bold;">${s.workers || 'N/A'}</div>
            </div>
          </div>`;
      } else if (viewName === 'tasks') {
        const tasks = data.tasks || [];
        if (tasks.length === 0) { el.innerHTML = '<p style="opacity:0.5;">No tasks.</p>'; return; }
        el.innerHTML = tasks.map(t =>
          '<div style="background:var(--bg-secondary);padding:0.75rem;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:0.5rem;">' +
          '<div style="display:flex;justify-content:space-between;"><strong>' + escapeHtml(t.title || 'Untitled') + '</strong>' +
          '<span style="font-size:0.75rem;opacity:0.6;">' + (t.status || '') + '</span></div>' +
          (t.description ? '<div style="font-size:0.85rem;opacity:0.7;margin-top:4px;">' + escapeHtml(t.description) + '</div>' : '') +
          '</div>'
        ).join('');
      } else if (viewName === 'workers') {
        const workers = data.workers || [];
        el.innerHTML = workers.map(w =>
          '<div style="background:var(--bg-secondary);padding:0.75rem;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:0.5rem;display:flex;align-items:center;gap:0.75rem;">' +
          '<div style="width:10px;height:10px;border-radius:50%;background:' + (w.status === 'healthy' ? 'var(--success)' : w.status === 'busy' ? 'var(--warning)' : 'var(--danger)') + ';"></div>' +
          '<div><strong>' + escapeHtml(w.name || w.id) + '</strong>' +
          '<div style="font-size:0.8rem;opacity:0.6;">' + (w.taskCount || 0) + ' tasks, ' + (w.listenerCount || 0) + ' listeners</div></div>' +
          '</div>'
        ).join('');
      } else if (viewName === 'costs') {
        el.innerHTML = '<pre style="white-space:pre-wrap;font-size:0.85rem;">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
      } else if (viewName === 'docs') {
        const files = (data.tree || []).filter(f => f.type === 'file').slice(0, 50);
        el.innerHTML = files.map(f =>
          '<div style="padding:4px 8px;cursor:pointer;border-radius:3px;margin-bottom:2px;" ' +
          'onclick="window._splitLoadDoc(\'' + f.path.replace(/'/g, "\\'") + '\')">' +
          escapeHtml(f.name) + '</div>'
        ).join('');
      } else {
        el.innerHTML = '<pre style="white-space:pre-wrap;font-size:0.85rem;">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>';
      }
    } catch (err) {
      el.innerHTML = '<p style="color:var(--danger);">Failed to load: ' + escapeHtml(err.message) + '</p>';
    }
  }

  window._splitLoadDoc = async function(path) {
    const el = document.getElementById('split-generic-content');
    if (!el) return;
    try {
      const data = await api('GET', '/vault/file?path=' + encodeURIComponent(path));
      el.innerHTML = '<div style="margin-bottom:0.5rem;"><button class="view-toolbar-btn" onclick="loadSplitRightView(\'docs\')">Back</button> <span style="font-size:0.8rem;opacity:0.6;">' + escapeHtml(path) + '</span></div>' +
        '<div class="markdown-body" style="line-height:1.6;">' +
        (typeof marked !== 'undefined' ? marked.parse(data.content || '') : '<pre>' + escapeHtml(data.content || '') + '</pre>') + '</div>';
    } catch (err) {
      el.innerHTML = '<p style="color:var(--danger);">Failed to load file</p>';
    }
  };

  async function loadSplitChat(channelId) {
    const container = document.getElementById('split-message-container');
    if (!container) return;
    try {
      const data = await api('GET', `/messages?channel=${channelId}&limit=50`);
      container.innerHTML = (data.messages || []).map(m =>
        `<div class="message" style="margin-bottom:0.75rem;">
          <div style="font-size:0.75rem;opacity:0.5;margin-bottom:2px;">
            <strong>${escapeHtml(m.from_user)}</strong>
            <span style="margin-left:0.5rem;">${new Date(m.created_at).toLocaleTimeString()}</span>
          </div>
          <div class="markdown-body">${typeof marked !== 'undefined' ? marked.parse(m.body || '') : escapeHtml(m.body || '')}</div>
        </div>`
      ).join('');
      container.scrollTop = container.scrollHeight;
    } catch (err) {
      container.innerHTML = `<p style="color:var(--danger);">Failed to load messages</p>`;
    }
  }

  async function sendMessage(channelId, body) {
    try {
      await api('POST', '/messages', { channel_id: channelId, body });
    } catch (err) {
      console.error('Send failed:', err);
    }
  }

  window._popoutCurrentView = function() {
    const view = currentView;
    const channel = currentChannel;
    window.open(`/view-popout.html?view=${view}&channel=${channel}`,
      `darkhan-${view}`, 'width=800,height=600,menubar=no,toolbar=no');
  };

  window._popoutSplitRight = function() {
    const view = splitRightView || 'chat';
    window.open(`/view-popout.html?view=${view}&channel=${currentChannel}`,
      `darkhan-${view}`, 'width=800,height=600,menubar=no,toolbar=no');
  };

  // Add toolbar buttons after views load
  setTimeout(addViewToolbarButtons, 1000);
  // Re-add after view switches
  const origShowView = showView;

  // --- Split Terminal (Unified Session Observer) ---

  function initSplitTerminal() {
    if (splitTerminal) return;
    const container = document.getElementById('split-terminal-container');
    if (!container) return;

    splitTerminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e94560',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#a5d6ff',
        white: '#e6edf3',
      },
      allowProposedApi: true,
    });

    splitFitAddon = new window.FitAddon.FitAddon();
    splitTerminal.loadAddon(splitFitAddon);
    splitTerminal.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    splitTerminal.open(container);
    splitFitAddon.fit();

    splitTerminal.onData((data) => {
      if (splitTerminalSocket && splitTerminalReady) {
        splitTerminalSocket.emit('terminal:input', { key: splitTerminalSessionKey, data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (splitFitAddon) {
        splitFitAddon.fit();
        if (splitTerminalSocket && splitTerminalReady) {
          splitTerminalSocket.emit('terminal:resize', { key: splitTerminalSessionKey, cols: splitTerminal.cols, rows: splitTerminal.rows });
        }
      }
    });
    resizeObserver.observe(container);

    splitTerminal.writeln('\x1b[1;36mDarkhan Terminal Observer\x1b[0m \u2014 Unified Claude Code session');
    splitTerminal.writeln('\x1b[90mShares context with @claude in channels. You can type here too.\x1b[0m\r\n');
  }

  function updateSplitTerminalStatus(text, color) {
    const el = document.getElementById('split-terminal-status');
    if (el) { el.textContent = text; el.style.color = color; }
  }

  window._connectSplitTerminal = function() {
    if (!splitTerminal) initSplitTerminal();

    if (!splitTerminalSocket || splitTerminalSocket.disconnected) {
      splitTerminalSocket = io('/terminal', { withCredentials: true });

      splitTerminalSocket.on('connect', () => {
        updateSplitTerminalStatus('Connecting...', 'var(--warning, #f39c12)');
        splitTerminalSocket.emit('terminal:spawn', {
          mode: 'claude',
          key: (currentUser || 'admin') + '_claude_observer',
          cols: splitTerminal.cols,
          rows: splitTerminal.rows,
        });
      });

      splitTerminalSocket.on('terminal:ready', ({ key, mode: m }) => {
        splitTerminalReady = true;
        splitTerminalSessionKey = key;
        updateSplitTerminalStatus('Live', 'var(--success, #27ae60)');
        document.getElementById('split-terminal-connect-btn').style.display = 'none';
        document.getElementById('split-terminal-disconnect-btn').style.display = 'inline-block';
        splitTerminal.focus();
      });

      splitTerminalSocket.on('terminal:restored', ({ key, mode: m }) => {
        splitTerminalReady = true;
        splitTerminalSessionKey = key;
        updateSplitTerminalStatus('Live (restored)', 'var(--success, #27ae60)');
        document.getElementById('split-terminal-connect-btn').style.display = 'none';
        document.getElementById('split-terminal-disconnect-btn').style.display = 'inline-block';
      });

      splitTerminalSocket.on('terminal:output', ({ data }) => {
        if (splitTerminal) splitTerminal.write(data);
      });

      splitTerminalSocket.on('terminal:exit', ({ exitCode }) => {
        splitTerminalReady = false;
        splitTerminalSessionKey = null;
        updateSplitTerminalStatus('Session ended', 'var(--warning, #f39c12)');
        document.getElementById('split-terminal-connect-btn').style.display = 'inline-block';
        document.getElementById('split-terminal-disconnect-btn').style.display = 'none';
        if (splitTerminal) splitTerminal.writeln(`\r\n\x1b[33m[Session ended \u2014 exit code ${exitCode}]\x1b[0m`);
      });

      splitTerminalSocket.on('terminal:error', ({ message }) => {
        if (splitTerminal) splitTerminal.writeln(`\r\n\x1b[31m[Error: ${message}]\x1b[0m`);
      });

      splitTerminalSocket.on('connect_error', (err) => {
        updateSplitTerminalStatus('Auth failed', 'var(--danger, #c0392b)');
      });

      splitTerminalSocket.on('disconnect', () => {
        splitTerminalReady = false;
        updateSplitTerminalStatus('Disconnected', 'var(--text-muted)');
      });
    } else {
      splitTerminalSocket.emit('terminal:spawn', {
        mode: 'claude',
        key: (currentUser || 'admin') + '_claude_observer',
        cols: splitTerminal.cols,
        rows: splitTerminal.rows,
      });
    }
  };

  window._disconnectSplitTerminal = function() {
    if (splitTerminalSocket && splitTerminalSessionKey) {
      splitTerminalSocket.emit('terminal:kill', { key: splitTerminalSessionKey });
    }
    splitTerminalReady = false;
    splitTerminalSessionKey = null;
    updateSplitTerminalStatus('Disconnected', 'var(--text-muted)');
    document.getElementById('split-terminal-connect-btn').style.display = 'inline-block';
    document.getElementById('split-terminal-disconnect-btn').style.display = 'none';
  };

  function cleanupSplitTerminal() {
    if (splitTerminalSocket) {
      if (splitTerminalSessionKey) {
        splitTerminalSocket.emit('terminal:kill', { key: splitTerminalSessionKey });
      }
      splitTerminalSocket.disconnect();
      splitTerminalSocket = null;
    }
    if (splitTerminal) {
      splitTerminal.dispose();
      splitTerminal = null;
    }
    splitFitAddon = null;
    splitTerminalReady = false;
    splitTerminalSessionKey = null;
  }

  // --- Claude Code Terminal ---
  function initTerminal() {
    if (terminal) {
      setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 100);
      return;
    }
    const container = document.getElementById('terminal-container');
    if (!container) return;

    terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', Menlo, monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e94560',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#7ee787',
        yellow: '#d29922',
        blue: '#79c0ff',
        magenta: '#d2a8ff',
        cyan: '#a5d6ff',
        white: '#e6edf3',
      },
      allowProposedApi: true,
    });

    fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    terminal.open(container);
    fitAddon.fit();

    terminal.onData((data) => {
      if (terminalSocket && terminalReady) {
        terminalSocket.emit('terminal:input', { key: terminalSessionKey, data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (terminalSocket && terminalReady) {
          terminalSocket.emit('terminal:resize', { key: terminalSessionKey, cols: terminal.cols, rows: terminal.rows });
        }
      }
    });
    resizeObserver.observe(container);

    terminal.writeln('\x1b[1;36mDarkhan Terminal\x1b[0m \u2014 Claude Code session');
    terminal.writeln('Click "Start Session" to spawn a Claude Code instance.\r\n');
  }

  function spawnTerminal() {
    if (!terminal) initTerminal();

    const mode = document.getElementById('terminal-mode').value || 'claude';
    const modeLabel = mode === 'claude' ? 'Claude Code' : 'Shell';

    if (!terminalSocket || terminalSocket.disconnected) {
      terminalSocket = io('/terminal', { withCredentials: true });

      terminalSocket.on('connect', () => {
        updateTerminalStatus('Connected', 'var(--success, #27ae60)');
        terminalSocket.emit('terminal:spawn', { mode, cols: terminal.cols, rows: terminal.rows });
      });

      terminalSocket.on('terminal:ready', ({ key, mode: m }) => {
        terminalReady = true;
        terminalSessionKey = key;
        const label = m === 'claude' ? 'Claude Code' : 'Shell';
        updateTerminalStatus(label + ' Active', 'var(--success, #27ae60)');
        document.getElementById('terminal-spawn-btn').style.display = 'none';
        document.getElementById('terminal-kill-btn').style.display = 'inline-block';
        document.getElementById('terminal-mode').disabled = true;
        terminal.focus();
      });

      terminalSocket.on('terminal:restored', ({ key, mode: m }) => {
        terminalReady = true;
        terminalSessionKey = key;
        const label = m === 'claude' ? 'Claude Code' : 'Shell';
        updateTerminalStatus(label + ' Restored', 'var(--success, #27ae60)');
        document.getElementById('terminal-spawn-btn').style.display = 'none';
        document.getElementById('terminal-kill-btn').style.display = 'inline-block';
        document.getElementById('terminal-mode').disabled = true;
        terminal.focus();
      });

      terminalSocket.on('terminal:output', ({ data }) => {
        if (terminal) terminal.write(data);
      });

      terminalSocket.on('terminal:exit', ({ exitCode }) => {
        terminalReady = false;
        terminalSessionKey = null;
        updateTerminalStatus('Exited', 'var(--warning, #f39c12)');
        document.getElementById('terminal-spawn-btn').style.display = 'inline-block';
        document.getElementById('terminal-kill-btn').style.display = 'none';
        document.getElementById('terminal-mode').disabled = false;
        if (terminal) terminal.writeln(`\r\n\x1b[33m[Session ended \u2014 exit code ${exitCode}]\x1b[0m`);
      });

      terminalSocket.on('terminal:error', ({ message }) => {
        if (terminal) terminal.writeln(`\r\n\x1b[31m[Error: ${message}]\x1b[0m`);
      });

      terminalSocket.on('connect_error', (err) => {
        updateTerminalStatus('Auth failed', 'var(--danger, #c0392b)');
        if (terminal) terminal.writeln(`\r\n\x1b[31m[Connection error: ${err.message}]\x1b[0m`);
      });

      terminalSocket.on('disconnect', () => {
        terminalReady = false;
        updateTerminalStatus('Disconnected', 'var(--text-muted)');
      });
    } else {
      terminalSocket.emit('terminal:spawn', { mode, cols: terminal.cols, rows: terminal.rows });
    }
  }

  function killTerminal() {
    if (terminalSocket) terminalSocket.emit('terminal:kill', { key: terminalSessionKey });
    terminalReady = false;
    terminalSessionKey = null;
    updateTerminalStatus('Stopped', 'var(--text-muted)');
    document.getElementById('terminal-spawn-btn').style.display = 'inline-block';
    document.getElementById('terminal-kill-btn').style.display = 'none';
    document.getElementById('terminal-mode').disabled = false;
  }

  function popoutTerminal() {
    const mode = document.getElementById('terminal-mode').value || 'claude';
    const w = window.open('/terminal-popout.html?mode=' + mode, 'darkhan-terminal',
      'width=900,height=700,menubar=no,toolbar=no,location=no,status=no');
    if (!w) alert('Pop-up blocked — please allow pop-ups for Darkhan.');
  }

  function updateTerminalStatus(text, color) {
    const el = document.getElementById('terminal-status');
    if (el) { el.textContent = text; el.style.color = color; }
  }

  // --- Init ---
  checkSession();
})();
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW registered!', reg.scope)).catch(err => console.error('SW failed', err)); }); }
