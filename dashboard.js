/* SUS Dashboard client: sheet-backed data loading, read-only roster views, and activity sync. */
(function () {
  'use strict';

  const Model = window.MEADashboardModel;
  if (!Model) return;

  const DASHBOARD_CACHE_KEY = 'mea_dashboard_cache_v1';
  const ACTIVITY_CACHE_KEY = 'mea_activity_cache_v1';
  const ACTIVITY_POLL_MS = 4000;
  const DASHBOARD_PREVIEW_POLL_MS = 20000;
  const MAX_BACKOFF_MS = 60000;

  const dashboardState = {
    data: null,
    project: '',
    filter: 'all',
    activity: [],
    activityCursor: null,
    activityTimer: null,
    previewTimer: null,
    activityBackoff: ACTIVITY_POLL_MS,
    activityInFlight: false,
    lastActivityRefresh: null,
    dashboardRequestInFlight: false
  };

  const FILTERS = [
    ['all', 'All members'],
    ['inventory', 'In Inventory'],
    ['with-project', 'With Project'],
    ['deployed', 'Deployed']
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function getLogin() {
    try {
      const raw = localStorage.getItem('mea_login_v1');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function getTrackerConfig() {
    try {
      const raw = localStorage.getItem('mea_cfg2');
      const cfg = raw ? JSON.parse(raw) : {};
      return cfg || {};
    } catch (e) { return {}; }
  }

  function getTrackerUrl() {
    const cfg = getTrackerConfig();
    return String(cfg.url || '').trim();
  }

  function getTrackerToken() {
    const cfg = getTrackerConfig();
    return String(cfg.token || '').trim();
  }

  function actor() {
    const login = getLogin() || {};
    return {
      id: String(login.idNumber || '').trim(),
      name: String(login.name || '').trim(),
      level: String(login.level || '').trim().toUpperCase()
    };
  }

  function canReadDashboard() {
    const level = actor().level;
    return level === 'ADMIN' || level === 'DASHBOARD';
  }

  function cacheRead(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function setConnection(target, text, tone) {
    const el = document.getElementById(target);
    if (!el) return;
    el.textContent = text;
    el.className = 'dashboard-connection ' + (tone || '');
  }

  function showAlert(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
  }

  function setLoading(loading) {
    const shell = document.getElementById('dashboard-loading');
    const content = document.getElementById('dashboard-content');
    if (shell) shell.hidden = !loading;
    if (content) content.hidden = loading || !dashboardState.data;
  }

  function buildQuery(action, extra) {
    const currentActor = actor();
    const params = Object.assign({ action, actorId: currentActor.id }, extra || {});
    const token = getTrackerToken();
    if (token) params.token = token;
    return new URLSearchParams(params).toString();
  }

  async function request(action, options) {
    const url = getTrackerUrl();
    if (!url) throw new Error('ID Tracker Apps Script URL is not configured.');
    const opts = options || {};
    const query = buildQuery(action, opts.query);
    const init = { method: opts.method || 'GET' };
    if (opts.body) {
      init.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      init.body = JSON.stringify(Object.assign({}, opts.body, { token: getTrackerToken() || undefined }));
    }
    const response = await fetch(url + '?' + query, init);
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('Apps Script returned an unexpected response.'); }
    if (!response.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Request failed (' + response.status + ').'));
    return json;
  }

  function normalizePayload(json) {
    return Model.normalizeResponse(json && (json.data || json.dashboard || json));
  }

  async function loadDashboard(options) {
    if (!canReadDashboard()) {
      showAlert('dashboard-error', 'Dashboard access is restricted to Admin and Dashboard users.');
      return;
    }
    if (dashboardState.dashboardRequestInFlight) return;
    dashboardState.dashboardRequestInFlight = true;
    const useCache = options && options.useCache;
    if (!dashboardState.data) setLoading(true);
    setConnection('dashboard-connection-state', navigator.onLine ? 'Refreshing…' : 'Offline', navigator.onLine ? 'pending' : 'offline');
    showAlert('dashboard-error', '');

    try {
      if (!navigator.onLine) throw new Error('offline');
      const json = await request('dashboardData');
      dashboardState.data = normalizePayload(json);
      cacheWrite(DASHBOARD_CACHE_KEY, { data: dashboardState.data, cachedAt: Date.now() });
      setConnection('dashboard-connection-state', 'Live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'online');
      renderDashboard();
    } catch (error) {
      const cached = cacheRead(DASHBOARD_CACHE_KEY);
      if (cached && cached.data) {
        dashboardState.data = Model.normalizeResponse(cached.data);
        setConnection('dashboard-connection-state', 'Cached · ' + new Date(cached.cachedAt || Date.now()).toLocaleDateString(), 'offline');
        showAlert('dashboard-error', error.message === 'offline' ? 'Offline — showing the last saved dashboard snapshot.' : 'Could not refresh dashboard — showing the last saved snapshot. ' + error.message);
        renderDashboard();
      } else {
        setConnection('dashboard-connection-state', 'Unavailable', 'error');
        showAlert('dashboard-error', error.message === 'offline' ? 'You are offline and no dashboard snapshot is cached on this device yet.' : error.message);
        setLoading(false);
      }
    } finally {
      dashboardState.dashboardRequestInFlight = false;
      setLoading(false);
    }
  }

  function renderDashboard() {
    const data = dashboardState.data;
    if (!data) return;
    setLoading(false);
    renderSummaryCards(data);
    renderReadiness(data);
    renderProjectOptions(data);
    renderFilters();
    renderRoster();
    renderActivityPreview();
  }

  function renderSummaryCards(data) {
    const totals = Model.totals(data.members);
    const cards = [
      ['totalRegistered', 'Total registered MEAns', 'chart-bar.svg'],
      ['inventory', 'IDs in Inventory', 'archive-box.svg'],
      ['withProject', 'IDs With Project', 'folder.svg'],
      ['deployed', 'IDs Deployed', 'check.svg']
    ];
    const container = document.getElementById('dashboard-summary-cards');
    if (!container) return;
    container.innerHTML = cards.map(([key, label, icon]) => `
      <div class="dashboard-metric-card" role="group" aria-label="${escapeAttr(label)}: ${totals[key]}">
        <span class="metric-icon"><img class="svg-icon" src="icons/ui/${icon}" alt=""></span>
        <span class="metric-value">${totals[key]}</span>
        <span class="metric-label">${escapeHtml(label)}</span>
      </div>`).join('');
  }

  function renderReadiness(data) {
    const list = document.getElementById('dashboard-readiness-list');
    if (!list) return;
    const matrix = Model.readinessMatrix(data.members, data.projects);
    const note = document.getElementById('readiness-formula-note');
    if (note) note.textContent = 'Deployed ÷ required IDs · blockers turn red';
    if (!matrix.length) {
      list.innerHTML = '<div class="dashboard-empty">No project columns were found in MAIN.</div>';
      return;
    }
    list.innerHTML = matrix.map(project => `
      <div class="readiness-row">
        <span class="traffic-light ${project.status}" aria-label="${project.status} status"></span>
        <span class="readiness-main"><strong>${escapeHtml(project.project)}</strong><span>${project.totalAssigned} assigned · ${project.membersRequiringIds} require IDs</span></span>
        <span class="readiness-stats"><b>${project.readiness}%</b><span>${project.idsDeployed}/${project.membersRequiringIds} deployed</span></span>
      </div>`).join('');
  }

  function renderProjectOptions(data) {
    const select = document.getElementById('dashboard-project-select');
    if (!select) return;
    const current = dashboardState.project;
    select.innerHTML = '<option value="">Select a project</option>' + data.projects.map(project => `<option value="${escapeAttr(project)}">${escapeHtml(project)}</option>`).join('');
    select.value = data.projects.includes(current) ? current : '';
  }

  function renderFilters() {
    const row = document.getElementById('dashboard-roster-filters');
    if (!row) return;
    row.innerHTML = FILTERS.map(([value, label]) => `<button type="button" class="filter-chip${dashboardState.filter === value ? ' active' : ''}" data-planner-filter="${value}">${escapeHtml(label)}</button>`).join('');
    row.querySelectorAll('[data-planner-filter]').forEach(button => button.addEventListener('click', () => {
      dashboardState.filter = button.dataset.plannerFilter;
      renderFilters();
      renderRoster();
    }));
  }

  function matchesFilter(member) {
    switch (dashboardState.filter) {
      case 'inventory': return member.state === 'INVENTORY';
      case 'with-project': return member.state === 'WITH_PROJECT';
      case 'deployed': return member.state === 'DEPLOYED';
      default: return true;
    }
  }

  function stateLabel(state) {
    return ({
      INVENTORY: 'Inventory', WITH_PROJECT: 'With Project', DEPLOYED: 'Deployed',
      MISSING: 'Missing', NEEDS_PRINTING: 'Needs Printing', NOT_REQUIRED: 'No ID Required', UNKNOWN: 'Unknown'
    })[state] || state;
  }

  function renderRoster() {
    const list = document.getElementById('dashboard-roster-list');
    if (!list || !dashboardState.data) return;
    const project = dashboardState.project;
    if (!project) {
      list.innerHTML = '<div class="dashboard-empty">Select a project to see its sheet-backed roster.</div>';
      return;
    }
    const members = dashboardState.data.members.filter(member => member.projects.includes(project) && matchesFilter(member));
    if (!members.length) {
      list.innerHTML = `<div class="dashboard-empty">No members match “${escapeHtml(FILTERS.find(item => item[0] === dashboardState.filter)[1])}”.</div>`;
      return;
    }
    list.innerHTML = members.map(member => `<div class="planner-member-row">
        <div class="planner-member-main"><div class="planner-name"><strong>${escapeHtml(member.fullName || 'Unnamed member')}</strong>${member.nickname ? `<span class="nickname">“${escapeHtml(member.nickname)}”</span>` : ''}</div><div class="planner-meta">${escapeHtml(member.idNumber || 'No ID')} · ${escapeHtml(member.department || 'Department not set')}</div></div>
        <div class="planner-status"><span class="state-pill state-${member.state.toLowerCase()}">${escapeHtml(stateLabel(member.state))}</span></div>
      </div>`).join('');
  }

  function focusRoster(filter) {
    if (!dashboardState.data) return;
    const project = dashboardState.project || dashboardState.data.projects[0] || '';
    dashboardState.project = project;
    dashboardState.filter = filter || 'all';
    renderProjectOptions(dashboardState.data);
    renderFilters();
    renderRoster();
    const panel = document.getElementById('dashboard-roster-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function formatEvent(event) {
    const action = event.actionType || event.action || 'Activity';
    const target = event.targetName || event.targetId || 'record';
    const detail = event.details || event.result || '';
    const when = event.serverTimestamp || event.timestamp;
    return `<div class="activity-row"><div class="activity-dot"></div><div class="activity-main"><strong>${escapeHtml(action)}</strong><span>${escapeHtml(target)}${event.project ? ' · ' + escapeHtml(event.project) : ''}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div><div class="activity-side"><span>${escapeHtml(event.actorName || event.actorId || 'System')}</span><time datetime="${escapeAttr(when || '')}">${escapeHtml(when ? new Date(when).toLocaleString() : '—')}</time></div></div>`;
  }

  function renderActivityPreview() {
    const container = document.getElementById('dashboard-activity-preview');
    if (!container) return;
    container.innerHTML = dashboardState.activity.length ? dashboardState.activity.slice(0, 5).map(formatEvent).join('') : '<div class="dashboard-empty">No activity recorded yet.</div>';
  }

  function renderActivityLog() {
    const container = document.getElementById('activity-list');
    if (!container) return;
    container.innerHTML = dashboardState.activity.length ? dashboardState.activity.map(formatEvent).join('') : '<div class="dashboard-empty">No activity recorded yet.</div>';
  }

  function setActivityConnection(text, tone) { setConnection('activity-connection-state', text, tone); }

  async function pollActivity(force) {
    if (!canReadDashboard() || dashboardState.activityInFlight || !navigator.onLine) {
      if (!navigator.onLine) setActivityConnection('Offline', 'offline');
      return;
    }
    dashboardState.activityInFlight = true;
    try {
      const json = await request('activity', { query: { cursor: dashboardState.activityCursor || '' } });
      const events = Array.isArray(json.events) ? json.events : [];
      dashboardState.activity = Model.mergeActivity(dashboardState.activity, events);
      dashboardState.activityCursor = json.nextCursor || json.cursor || (dashboardState.activity[0] && dashboardState.activity[0].eventId) || dashboardState.activityCursor;
      dashboardState.lastActivityRefresh = Date.now();
      cacheWrite(ACTIVITY_CACHE_KEY, { events: dashboardState.activity, cursor: dashboardState.activityCursor, cachedAt: Date.now() });
      setActivityConnection('Live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'online');
      const refresh = document.getElementById('activity-last-refresh');
      if (refresh) refresh.textContent = 'Last successful refresh ' + new Date().toLocaleTimeString();
      const note = document.getElementById('activity-cached-note');
      if (note) note.hidden = true;
      showAlert('activity-error', '');
      renderActivityPreview();
      renderActivityLog();
      dashboardState.activityBackoff = ACTIVITY_POLL_MS;
    } catch (error) {
      const cached = cacheRead(ACTIVITY_CACHE_KEY);
      if (!dashboardState.activity.length && cached && cached.events) {
        dashboardState.activity = Model.mergeActivity([], cached.events);
        dashboardState.activityCursor = cached.cursor || null;
        const note = document.getElementById('activity-cached-note');
        if (note) note.hidden = false;
        renderActivityPreview();
        renderActivityLog();
      }
      setActivityConnection('Retrying…', 'error');
      showAlert('activity-error', 'Live activity refresh failed. Retrying with backoff. ' + error.message);
      dashboardState.activityBackoff = Math.min(MAX_BACKOFF_MS, Math.max(ACTIVITY_POLL_MS, dashboardState.activityBackoff * 2));
    } finally {
      dashboardState.activityInFlight = false;
      scheduleActivityPoll(activityViewVisible() ? dashboardState.activityBackoff : DASHBOARD_PREVIEW_POLL_MS);
    }
  }

  function scheduleActivityPoll(delay) {
    clearTimeout(dashboardState.activityTimer);
    if (document.hidden || !canReadDashboard()) return;
    dashboardState.activityTimer = setTimeout(() => {
      if (document.hidden) return;
      pollActivity(false);
    }, delay || ACTIVITY_POLL_MS);
  }

  function activityViewVisible() {
    const view = document.getElementById('view-activity-log');
    return !!(view && view.classList.contains('active'));
  }

  function schedulePreviewPoll() {
    clearTimeout(dashboardState.previewTimer);
    if (document.hidden || !canReadDashboard()) return;
    dashboardState.previewTimer = setTimeout(() => {
      if (!document.hidden && dashboardState.data) pollActivity(false);
      schedulePreviewPoll();
    }, DASHBOARD_PREVIEW_POLL_MS);
  }

  function guardView(view) {
    if (!canReadDashboard()) {
      if (window.showToast) window.showToast('Dashboard access is restricted.', true);
      if (window.showView) window.showView('home');
      return false;
    }
    if (view === 'activity-log') {
      const cached = cacheRead(ACTIVITY_CACHE_KEY);
      if (!dashboardState.activity.length && cached && cached.events) {
        dashboardState.activity = Model.mergeActivity([], cached.events);
        dashboardState.activityCursor = cached.cursor || null;
        const note = document.getElementById('activity-cached-note');
        if (note) note.hidden = false;
        renderActivityLog();
      }
      pollActivity(true);
    }
    return true;
  }

  function bind() {
    const dashboardButton = document.getElementById('home-nav-dashboard');
    if (dashboardButton) dashboardButton.addEventListener('click', () => { if (guardView('dashboard')) showView('dashboard'); });
    document.querySelectorAll('.restricted-dashboard-nav').forEach(button => button.addEventListener('click', event => {
      if (!guardView(button.dataset.mainview)) event.preventDefault();
    }));
    document.getElementById('dashboard-project-select').addEventListener('change', event => {
      dashboardState.project = event.target.value;
      renderRoster();
    });
    document.getElementById('dashboard-refresh-btn').addEventListener('click', () => loadDashboard());
    document.getElementById('activity-refresh-btn').addEventListener('click', () => pollActivity(true));
    document.getElementById('view-all-activity-btn').addEventListener('click', () => { if (guardView('activity-log')) showView('activity-log'); });
    document.addEventListener('mea:viewchange', event => {
      const view = event.detail && event.detail.view;
      if (view === 'dashboard') { guardView(view); loadDashboard(); schedulePreviewPoll(); }
      if (view === 'activity-log') { guardView(view); renderActivityLog(); }
      if (view !== 'activity-log') clearTimeout(dashboardState.activityTimer);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(dashboardState.activityTimer); clearTimeout(dashboardState.previewTimer); return; }
      if (canReadDashboard()) { loadDashboard(); pollActivity(true); schedulePreviewPoll(); }
    });
    window.addEventListener('online', () => { if (canReadDashboard()) { loadDashboard(); pollActivity(true); } });
    window.addEventListener('offline', () => { setConnection('dashboard-connection-state', 'Offline', 'offline'); setActivityConnection('Offline', 'offline'); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    if (canReadDashboard()) {
      const cached = cacheRead(ACTIVITY_CACHE_KEY);
      if (cached && cached.events) dashboardState.activity = Model.mergeActivity([], cached.events);
      renderActivityPreview();
    }
  });

  window.meaDashboard = {
    load: loadDashboard,
    refreshActivity: () => pollActivity(true),
    getState: () => dashboardState
  };
})();
