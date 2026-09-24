/* SUS Dashboard client: data loading, project planning, activity sync, and UI. */
(function () {
  'use strict';

  const Rules = window.MEADashboardRules;
  const Model = window.MEADashboardModel;
  if (!Rules || !Model) return;

  const DASHBOARD_CACHE_KEY = 'mea_dashboard_cache_v1';
  const ACTIVITY_CACHE_KEY = 'mea_activity_cache_v1';
  const ACTIVITY_POLL_MS = 4000;
  const DASHBOARD_PREVIEW_POLL_MS = 20000;
  const MAX_BACKOFF_MS = 60000;

  const dashboardState = {
    data: null,
    project: '',
    filter: 'all',
    selectedIds: new Set(),
    activity: [],
    activityCursor: null,
    activityTimer: null,
    previewTimer: null,
    activityBackoff: ACTIVITY_POLL_MS,
    activityInFlight: false,
    lastActivityRefresh: null,
    pendingMove: null,
    dashboardRequestInFlight: false
  };

  const FILTERS = [
    ['all', 'All members'],
    ['inventory', 'In Inventory'],
    ['with-project', 'With Project'],
    ['needs-deployment', 'Needs deployment'],
    ['deployed', 'Already deployed'],
    ['needs-printing', 'Needs printing'],
    ['missing', 'Missing ID'],
    ['not-required', 'No ID required'],
    ['data-issues', 'Has data issues']
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

  function canWriteDashboard() { return actor().level === 'ADMIN'; }

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
      if (useCache) setLoading(false);
    }
  }

  function renderDashboard() {
    const data = dashboardState.data;
    if (!data) return;
    setLoading(false);
    renderSummaryCards(data);
    renderReadiness(data);
    renderExceptions(data);
    renderProjectOptions(data);
    renderFilters();
    renderPlanner();
    renderActivityPreview();
  }

  function renderSummaryCards(data) {
    const totals = Model.totals(data.members);
    const cards = [
      ['totalRegistered', 'Total registered MEAns', 'all', 'chart-bar.svg'],
      ['inventory', 'IDs in Inventory', 'inventory', 'archive-box.svg'],
      ['withProject', 'IDs With Project', 'with-project', 'folder.svg'],
      ['deployed', 'IDs Deployed', 'deployed', 'check.svg'],
      ['needsPrinting', 'IDs needing printing', 'needs-printing', 'warning.svg'],
      ['requiredMissing', 'Required IDs missing', 'missing', 'warning.svg'],
      ['dataIssues', 'Duplicate or incomplete data', 'data-issues', 'info.svg']
    ];
    const container = document.getElementById('dashboard-summary-cards');
    if (!container) return;
    container.innerHTML = cards.map(([key, label, filter, icon]) => `
      <button type="button" class="dashboard-metric-card" data-summary-filter="${escapeAttr(filter)}" aria-label="${escapeAttr(label)}: ${totals[key]}">
        <span class="metric-icon"><img class="svg-icon" src="icons/ui/${icon}" alt=""></span>
        <span class="metric-value">${totals[key]}</span>
        <span class="metric-label">${escapeHtml(label)}</span>
      </button>`).join('');
    container.querySelectorAll('[data-summary-filter]').forEach(card => card.addEventListener('click', () => {
      const filter = card.dataset.summaryFilter;
      focusPlanner(filter);
    }));
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
      <button type="button" class="readiness-row" data-readiness-project="${escapeAttr(project.project)}">
        <span class="traffic-light ${project.status}" aria-label="${project.status} status"></span>
        <span class="readiness-main"><strong>${escapeHtml(project.project)}</strong><span>${project.totalAssigned} assigned · ${project.membersRequiringIds} require IDs</span></span>
        <span class="readiness-stats"><b>${project.readiness}%</b><span>${project.idsDeployed}/${project.membersRequiringIds} deployed</span></span>
        <span class="readiness-chevron" aria-hidden="true">›</span>
      </button>`).join('');
    list.querySelectorAll('[data-readiness-project]').forEach(row => row.addEventListener('click', () => {
      dashboardState.project = row.dataset.readinessProject;
      dashboardState.filter = 'all';
      renderProjectOptions(data);
      renderFilters();
      renderPlanner();
      document.getElementById('deployment-planner-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function renderExceptions(data) {
    const list = document.getElementById('dashboard-exceptions-list');
    const count = document.getElementById('dashboard-exception-count');
    if (!list) return;
    const exceptions = Model.detectExceptions(data);
    if (count) count.textContent = exceptions.length + (exceptions.length === 1 ? ' issue' : ' issues');
    if (!exceptions.length) {
      list.innerHTML = '<div class="dashboard-empty success-empty"><img class="svg-icon" src="icons/ui/check.svg" alt="">No exceptions detected.</div>';
      return;
    }
    list.innerHTML = exceptions.slice(0, 20).map(issue => `
      <button type="button" class="exception-row severity-${escapeAttr(issue.severity)}" data-exception-id="${escapeAttr(issue.affectedId)}" data-exception-type="${escapeAttr(issue.type)}">
        <span class="severity-dot" aria-hidden="true"></span>
        <span class="exception-main"><strong>${escapeHtml(issue.type)}</strong><span>${escapeHtml(issue.explanation)}</span></span>
        <span class="exception-action">Review ›</span>
      </button>`).join('') + (exceptions.length > 20 ? `<div class="muted exception-overflow">Showing 20 of ${exceptions.length} exceptions.</div>` : '');
    list.querySelectorAll('[data-exception-id]').forEach(row => row.addEventListener('click', () => {
      const member = data.members.find(item => item.idNumber === row.dataset.exceptionId);
      if (member && member.projects.length) dashboardState.project = member.projects[0];
      dashboardState.filter = 'data-issues';
      renderProjectOptions(data);
      renderFilters();
      renderPlanner();
      document.getElementById('deployment-planner-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function renderProjectOptions(data) {
    const select = document.getElementById('dashboard-project-select');
    if (!select) return;
    const current = dashboardState.project;
    select.innerHTML = '<option value="">Select a project</option>' + data.projects.map(project => `<option value="${escapeAttr(project)}">${escapeHtml(project)}</option>`).join('');
    select.value = data.projects.includes(current) ? current : '';
  }

  function renderFilters() {
    const row = document.getElementById('deployment-filters');
    if (!row) return;
    row.innerHTML = FILTERS.map(([value, label]) => `<button type="button" class="filter-chip${dashboardState.filter === value ? ' active' : ''}" data-planner-filter="${value}">${escapeHtml(label)}</button>`).join('');
    row.querySelectorAll('[data-planner-filter]').forEach(button => button.addEventListener('click', () => {
      dashboardState.filter = button.dataset.plannerFilter;
      dashboardState.selectedIds.clear();
      renderFilters();
      renderPlanner();
    }));
  }

  function matchesFilter(member) {
    switch (dashboardState.filter) {
      case 'inventory': return member.state === Rules.STATES.INVENTORY;
      case 'with-project': return member.state === Rules.STATES.WITH_PROJECT;
      case 'needs-deployment': return Rules.needsDeployment(member);
      case 'deployed': return member.state === Rules.STATES.DEPLOYED;
      case 'needs-printing': return member.state === Rules.STATES.NEEDS_PRINTING;
      case 'missing': return member.state === Rules.STATES.MISSING || (member.requiresId === true && member.state === Rules.STATES.UNKNOWN);
      case 'not-required': return member.requiresId === false;
      case 'data-issues': return (member.dataIssues || []).length > 0 || (member.warnings || []).length > 0;
      default: return true;
    }
  }

  function stateLabel(state) {
    return ({
      INVENTORY: 'Inventory', WITH_PROJECT: 'With Project', DEPLOYED: 'Deployed',
      MISSING: 'Missing', NEEDS_PRINTING: 'Needs Printing', NOT_REQUIRED: 'No ID Required', UNKNOWN: 'Unknown'
    })[state] || state;
  }

  function renderPlanner() {
    const list = document.getElementById('deployment-list');
    if (!list || !dashboardState.data) return;
    const project = dashboardState.project;
    if (!project) {
      list.innerHTML = '<div class="dashboard-empty">Select a project to see assigned members.</div>';
      updateSelectionToolbar();
      return;
    }
    const members = dashboardState.data.members.filter(member => member.projects.includes(project) && matchesFilter(member));
    if (!members.length) {
      list.innerHTML = `<div class="dashboard-empty">No members match “${escapeHtml(FILTERS.find(item => item[0] === dashboardState.filter)[1])}”.</div>`;
      updateSelectionToolbar();
      return;
    }
    list.innerHTML = members.map(member => {
      const selectable = canWriteDashboard() && member.idNumber && member.requiresId === true && [Rules.STATES.INVENTORY, Rules.STATES.WITH_PROJECT].includes(member.state);
      const checked = dashboardState.selectedIds.has(member.idNumber);
      const warnings = (member.dataIssues || []).concat(member.warnings || []);
      return `<div class="planner-member-row${warnings.length ? ' has-issues' : ''}">
        <div class="planner-check">${selectable ? `<input type="checkbox" class="member-select" data-member-id="${escapeAttr(member.idNumber)}"${checked ? ' checked' : ''} aria-label="Select ${escapeAttr(member.fullName || member.idNumber)}">` : '<span class="check-placeholder" aria-hidden="true"></span>'}</div>
        <div class="planner-member-main"><div class="planner-name"><strong>${escapeHtml(member.fullName || 'Unnamed member')}</strong>${member.nickname ? `<span class="nickname">“${escapeHtml(member.nickname)}”</span>` : ''}</div><div class="planner-meta">${escapeHtml(member.idNumber || 'No ID')} · ${escapeHtml(member.department || 'Department not set')}</div>${warnings.length ? `<div class="planner-warning"><img class="svg-icon" src="icons/ui/warning.svg" alt="">${escapeHtml(warnings.join(' · '))}</div>` : ''}</div>
        <div class="planner-status"><span class="state-pill state-${member.state.toLowerCase()}">${escapeHtml(stateLabel(member.state))}</span><span class="planner-action">${escapeHtml(Rules.recommendedAction(member))}</span></div>
      </div>`;
    }).join('');
    list.querySelectorAll('.member-select').forEach(input => input.addEventListener('change', () => {
      if (input.checked) dashboardState.selectedIds.add(input.dataset.memberId);
      else dashboardState.selectedIds.delete(input.dataset.memberId);
      updateSelectionToolbar();
    }));
    updateSelectionToolbar();
  }

  function updateSelectionToolbar() {
    const count = document.getElementById('deployment-selection-count');
    const button = document.getElementById('deployment-move-btn');
    if (count) count.textContent = dashboardState.selectedIds.size + (dashboardState.selectedIds.size === 1 ? ' selected' : ' selected');
    if (button) button.disabled = !canWriteDashboard() || dashboardState.selectedIds.size === 0 || !dashboardState.project;
  }

  function focusPlanner(filter) {
    if (!dashboardState.data) return;
    const project = dashboardState.project || dashboardState.data.projects[0] || '';
    dashboardState.project = project;
    dashboardState.filter = filter || 'all';
    renderProjectOptions(dashboardState.data);
    renderFilters();
    renderPlanner();
    const panel = document.getElementById('deployment-planner-panel');
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

  function showConfirmation() {
    const selected = Array.from(dashboardState.selectedIds).map(id => dashboardState.data.members.find(member => member.idNumber === id)).filter(Boolean);
    if (!selected.length || !dashboardState.project) return;
    const destination = document.getElementById('deployment-destination').value;
    dashboardState.pendingMove = { project: dashboardState.project, destination, members: selected };
    document.getElementById('deployment-confirm-summary').innerHTML = `<strong>${escapeHtml(dashboardState.project)}</strong><span>Move ${selected.length} ID${selected.length === 1 ? '' : 's'} to <strong>${escapeHtml(destination === 'DEPLOYED' ? 'Deployed' : 'With Project')}</strong></span>`;
    document.getElementById('deployment-confirm-list').innerHTML = selected.map(member => `<div><span>${escapeHtml(member.idNumber)}</span><span>${escapeHtml(member.fullName || 'Unnamed member')}</span></div>`).join('');
    const modal = document.getElementById('deployment-confirm-backdrop');
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('deployment-confirm-submit').focus();
  }

  function hideConfirmation() {
    const modal = document.getElementById('deployment-confirm-backdrop');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    dashboardState.pendingMove = null;
  }

  function makeIdempotencyKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  async function submitMove() {
    const move = dashboardState.pendingMove;
    if (!move || !canWriteDashboard()) return;
    const submit = document.getElementById('deployment-confirm-submit');
    submit.disabled = true;
    submit.textContent = 'Validating…';
    const batchId = makeIdempotencyKey();
    try {
      const json = await request('batchMove', {
        method: 'POST',
        query: {},
        body: {
          action: 'batchMove',
          actorId: actor().id,
          actorName: actor().name,
          batchId,
          idempotencyKey: batchId,
          project: move.project,
          destination: move.destination,
          ids: move.members.map(member => member.idNumber),
          deviceId: getDeviceId()
        }
      });
      hideConfirmation();
      dashboardState.selectedIds.clear();
      const results = Array.isArray(json.results) ? json.results : [];
      const failed = results.filter(result => result.ok === false || result.result === 'rejected');
      const resultBox = document.getElementById('deployment-result');
      if (resultBox) {
        resultBox.hidden = false;
        resultBox.className = 'dashboard-result ' + (failed.length ? 'warning' : 'success');
        resultBox.textContent = failed.length ? `${failed.length} of ${results.length || move.members.length} record(s) were rejected. No ambiguous change was applied; refresh to review the latest state.` : `Moved ${move.members.length} ID${move.members.length === 1 ? '' : 's'} successfully.`;
      }
      if (Array.isArray(json.events)) dashboardState.activity = Model.mergeActivity(dashboardState.activity, json.events);
      await loadDashboard();
      await pollActivity(true);
    } catch (error) {
      hideConfirmation();
      const resultBox = document.getElementById('deployment-result');
      if (resultBox) { resultBox.hidden = false; resultBox.className = 'dashboard-result warning'; resultBox.textContent = 'Move rejected: ' + error.message; }
      await loadDashboard();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Confirm move';
    }
  }

  function getDeviceId() {
    const key = 'mea_dashboard_device_id';
    try {
      let id = localStorage.getItem(key);
      if (!id) { id = makeIdempotencyKey(); localStorage.setItem(key, id); }
      return id;
    } catch (e) { return 'ephemeral-' + makeIdempotencyKey(); }
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
      dashboardState.selectedIds.clear();
      renderPlanner();
    });
    document.getElementById('deployment-destination').addEventListener('change', () => {});
    document.getElementById('deployment-move-btn').addEventListener('click', showConfirmation);
    document.getElementById('deployment-confirm-cancel').addEventListener('click', hideConfirmation);
    document.getElementById('deployment-confirm-submit').addEventListener('click', submitMove);
    document.getElementById('deployment-confirm-backdrop').addEventListener('click', event => { if (event.target.id === 'deployment-confirm-backdrop') hideConfirmation(); });
    document.getElementById('dashboard-refresh-btn').addEventListener('click', () => loadDashboard());
    document.getElementById('activity-refresh-btn').addEventListener('click', () => pollActivity(true));
    document.getElementById('view-all-activity-btn').addEventListener('click', () => { if (guardView('activity-log')) showView('activity-log'); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideConfirmation(); });
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
