// ─── State ────────────────────────────────────────────────────────────────────
let currentTab = null;
let tabs = [];
let modalContext = {}; // Stores context for open modals
let tabDataCache = {}; // Cache of last-loaded data per tab

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function ordinal(n) {
  const v = n % 100;
  return n + (['th','st','nd','rd'][(v - 20) % 10] || ['th','st','nd','rd'][v] || 'th');
}

// Display: DD-MM-YYYY or YYYY-MM-DD → "March, 3rd"
function formatDateForDisplay(dateStr) {
  if (!dateStr) return '';
  let day, month;
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    [day, month] = dateStr.split('-').map(Number);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [, month, day] = dateStr.split('-').map(Number);
  } else {
    return dateStr;
  }
  return `${MONTHS[month - 1]}, ${ordinal(day)}`;
}

// For saving: YYYY-MM-DD (from <input type="date">) → DD-MM-YYYY (Sheet format)
function formatDateForSheet(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || '';
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

// For date inputs: DD-MM-YYYY (Sheet) → YYYY-MM-DD (input value)
function sheetDateToIso(dateStr) {
  if (!dateStr) return '';
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split('-');
    return `${y}-${m}-${d}`;
  }
  return dateStr;
}

function statusBadge(status) {
  const map = {
    'Inbox':       'badge-inbox',
    'To Do':       'badge-todo',
    'In Progress': 'badge-inprogress',
    'Blocked':     'badge-blocked',
    'Done':        'badge-done',
  };
  const cls = map[status] || 'badge-todo';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function priorityBadge(priority) {
  const map = { 'Low': 'pri-low', 'Medium': 'pri-medium', 'High': 'pri-high', 'Urgent': 'pri-urgent' };
  const cls = map[priority] || 'pri-medium';
  return priority ? `<span class="pri ${cls}">${esc(priority)}</span>` : '';
}

// Tabs that show a flat list (no PROJECT/TASK hierarchy)
const FLAT_TABS = new Set(['Inbox', 'Michel_Review', 'Archive']);

// ─── Tab navigation ───────────────────────────────────────────────────────────
function renderTabNav() {
  const nav = document.getElementById('tab-nav');
  nav.innerHTML = tabs
    .map(t => `<button class="tab-btn${t === currentTab ? ' active' : ''}" data-tab="${escAttr(t)}">${esc(t.replace(/_/g, ' '))}</button>`)
    .join('');
  nav.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
}

async function switchTab(tabName) {
  currentTab = tabName;
  renderTabNav();
  await loadTabData(tabName);
}

async function loadTabData(tabName) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading"><span class="spinner"></span> Loading...</div>';
  try {
    const data = await api(`/api/data/${encodeURIComponent(tabName)}`);
    if (data) { tabDataCache[tabName] = data; renderTabContent(tabName, data); }
  } catch (err) {
    main.innerHTML = `<div class="loading">Failed to load: ${esc(err.message)}</div>`;
  }
}

// ─── Render dispatch ──────────────────────────────────────────────────────────
function renderTabContent(tabName, data) {
  const main = document.getElementById('main-content');
  if (FLAT_TABS.has(tabName)) {
    renderFlatTab(tabName, data, main);
  } else {
    renderHierarchicalTab(tabName, data, main);
  }
}

// ─── Hierarchical tab (projects + tasks) ──────────────────────────────────────
function renderHierarchicalTab(tabName, data, container) {
  const { rows } = data;
  const projects = rows.filter(r => r.data['Type'] === 'PROJECT');
  const tasks    = rows.filter(r => r.data['Type'] === 'TASK');
  const orphans  = rows.filter(r => r.data['Type'] !== 'PROJECT' && r.data['Type'] !== 'TASK' && r.data['Name']);

  let html = `
    <div class="tab-toolbar">
      <button class="btn btn-secondary btn-sm btn-add-project" data-tab="${escAttr(tabName)}">+ New Project</button>
    </div>`;

  if (rows.length === 0) {
    html += '<div class="empty-state">No items yet. Create your first project above.</div>';
  }

  for (const proj of projects) {
    const p = proj.data;
    const projTasks = tasks.filter(t => String(t.data['Parent_ID']) === String(p['ID']));
    const totalTasks = projTasks.length;
    const doneTasks  = projTasks.filter(t => t.data['Status'] === 'Done').length;
    const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

    html += `
      <div class="project-card" data-id="${esc(p['ID'])}" data-tab="${escAttr(tabName)}">
        <div class="project-header" data-project-id="${esc(p['ID'])}">
          <span class="project-name">${esc(p['Name'])}</span>
          <div class="project-progress-wrap">
            <div class="project-progress-bar">
              <div class="project-progress-fill" style="width:${pct}%"></div>
            </div>
            <span class="project-progress-label">${pct}%</span>
          </div>
        </div>
        <div class="task-list hidden" id="tl-${esc(p['ID'])}">
          ${projTasks.map(t => renderTaskRow(t.data, tabName)).join('')}
          <div class="add-task-row">
            <button class="btn btn-ghost btn-sm btn-add-task" data-tab="${escAttr(tabName)}" data-pid="${esc(p['ID'])}" data-pname="${escAttr(p['Name'])}">+ Add task</button>
          </div>
        </div>
      </div>`;
  }

  if (orphans.length > 0) {
    html += `
      <div class="project-card">
        <div class="project-header" data-project-id="__orphans">
          <svg class="chevron open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 4 10 8 6 12"/>
          </svg>
          <span class="project-name">Uncategorized</span>
        </div>
        <div class="task-list" id="tl-__orphans">
          ${orphans.map(r => renderTaskRow(r.data, tabName)).join('')}
        </div>
      </div>`;
  }

  container.innerHTML = html;
  bindHierarchicalEvents(container, tabName);
}

function renderTaskRow(d, tabName) {
  const isDone = d['Status'] === 'Done';
  const statusCls = { 'Inbox': 'badge-inbox', 'To Do': 'badge-todo', 'In Progress': 'badge-inprogress', 'Blocked': 'badge-blocked', 'Done': 'badge-done' }[d['Status']] || 'badge-todo';
  return `
    <div class="task-row${isDone ? ' task-done' : ''}" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}">
      <span class="task-name task-name-link${isDone ? ' task-name-strike' : ''}" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}">${esc(d['Name'])}</span>
      <span class="task-exec-date">${esc(formatDateForDisplay(d['Execution_Date'] || ''))}</span>
      <button class="badge ${statusCls} task-status-btn" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}" data-val="${escAttr(d['Status'] || 'To Do')}">${esc(d['Status'] || 'To Do')}</button>
    </div>`;
}

function bindHierarchicalEvents(container, tabName) {
  // Collapse / expand — click anywhere on header
  container.querySelectorAll('.project-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const pid = hdr.dataset.projectId;
      const tl = document.getElementById(`tl-${pid}`);
      if (tl) tl.classList.toggle('hidden');
    });
  });

  // Add project
  container.querySelectorAll('.btn-add-project').forEach(btn =>
    btn.addEventListener('click', () => openAddProject(btn.dataset.tab))
  );

  // Add task
  container.querySelectorAll('.btn-add-task').forEach(btn =>
    btn.addEventListener('click', () => openAddTask(btn.dataset.tab, btn.dataset.pid, btn.dataset.pname))
  );

  // Task name → detail modal
  container.querySelectorAll('.task-name-link').forEach(span =>
    span.addEventListener('click', () => openTaskDetail(span.dataset.tab, span.dataset.id))
  );

  // Task status badge → status modal
  container.querySelectorAll('.task-status-btn').forEach(btn =>
    btn.addEventListener('click', () => openStatus(btn.dataset.tab, btn.dataset.id, btn.dataset.val))
  );
}

// ─── Flat tab (Inbox, Claude_Review, Archive) ─────────────────────────────────
function renderFlatTab(tabName, data, container) {
  const { headers, rows } = data;
  let html = '';

  if (tabName === 'Inbox') {
    html += `
      <div class="flat-section-header">
        <button class="btn btn-secondary btn-sm" id="btn-add-inbox">+ Add to Inbox</button>
      </div>`;
  }

  if (rows.length === 0) {
    html += '<div class="empty-state">Nothing here yet.</div>';
  } else {
    for (const row of rows) {
      const d = row.data;
      const id        = d['ID'] || d['Review_ID'] || '';
      const name      = d['Name'] || d['Reference_Name'] || '(no name)';
      const notes     = d['Notes'] || d['Review_Note'] || '';
      const dateVal   = d['Created_Date'] || d['Review_Date'] || d['Completed_Date'] || '';
      const status    = d['Status'] || '';
      const priority  = d['Priority'] || '';
      const category  = d['Category'] || '';

      const metaParts = [];
      if (status)   metaParts.push(statusBadge(status));
      if (priority) metaParts.push(priorityBadge(priority));
      if (category) metaParts.push(`<span class="pri pri-medium">${esc(category)}</span>`);

      html += `
        <div class="flat-row" data-id="${esc(id)}" data-tab="${escAttr(tabName)}">
          <div class="flat-row-body">
            <div class="flat-row-name">${esc(name)}</div>
            ${notes ? `<div class="flat-row-notes">${esc(notes)}</div>` : ''}
            ${metaParts.length ? `<div class="flat-row-meta">${metaParts.join('')}</div>` : ''}
          </div>
          <div class="flat-row-date">${esc(formatDateForDisplay(dateVal))}</div>
          ${tabName !== 'Archive' ? `
          <div class="flat-row-actions">
            <button class="btn btn-ghost btn-sm btn-notes" data-id="${esc(id)}" data-tab="${escAttr(tabName)}" data-val="${escAttr(d['Notes'] || '')}">Notes</button>
          </div>` : ''}
        </div>`;
    }
  }

  container.innerHTML = html;

  if (tabName === 'Inbox') {
    document.getElementById('btn-add-inbox')?.addEventListener('click', openCapture);
  }

  container.querySelectorAll('.btn-notes').forEach(btn =>
    btn.addEventListener('click', () => openNotes(btn.dataset.tab, btn.dataset.id, btn.dataset.val))
  );
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function openCapture() {
  document.getElementById('capture-name').value = '';
  document.getElementById('capture-notes').value = '';
  openModal('modal-capture');
  setTimeout(() => document.getElementById('capture-name').focus(), 50);
}

function openStatus(tab, id, current) {
  modalContext.status = { tab, id };
  document.getElementById('status-value').value = current || 'To Do';
  openModal('modal-status');
}

function openNotes(tab, id, current) {
  modalContext.notes = { tab, id };
  document.getElementById('notes-value').value = current || '';
  openModal('modal-notes');
  setTimeout(() => document.getElementById('notes-value').focus(), 50);
}

// ─── Time / Duration Carousels ────────────────────────────────────────────────
const TC_TIME_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const TC_DUR_STEPS  = [0, 15, 30, 45];

const tcState = {
  'exec-time': { active: false, h: 9, m: 0 },
  'duration':  { h: 0, m: 45 },
};

function tcSnapStep(val, steps) {
  return steps.reduce((best, s) => Math.abs(s - val) < Math.abs(best - val) ? s : best);
}

function parseDurationClient(str) {
  if (!str) return 0;
  str = String(str).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let mins = 0;
  const h = str.match(/(\d+(?:\.\d+)?)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  if (h) mins += Math.round(parseFloat(h[1]) * 60);
  if (m) mins += parseInt(m[1], 10);
  return mins;
}

function tcRender(name) {
  const s = tcState[name];
  if (name === 'exec-time') {
    const active = s.active;
    document.getElementById('tc-exec-time-h').textContent = active ? String(s.h).padStart(2,'0') : '--';
    document.getElementById('tc-exec-time-m').textContent = active ? String(s.m).padStart(2,'0') : '--';
    document.getElementById('detail-execution-time').value = active ? `${String(s.h).padStart(2,'0')}:${String(s.m).padStart(2,'0')}` : '';
  } else {
    document.getElementById('tc-duration-h').textContent = String(s.h);
    document.getElementById('tc-duration-m').textContent = String(s.m).padStart(2,'0');
    const total = s.h * 60 + s.m;
    document.getElementById('detail-duration').value = total > 0 ? String(total) : '';
  }
}

function tcInit(name, value) {
  if (name === 'exec-time') {
    if (!value) {
      tcState[name] = { active: false, h: 9, m: 0 };
    } else {
      const [hh, mm] = value.split(':').map(n => parseInt(n, 10) || 0);
      tcState[name] = { active: true, h: hh, m: tcSnapStep(mm, TC_TIME_STEPS) };
    }
  } else {
    const total = parseDurationClient(value);
    if (total === 0) {
      tcState[name] = { h: 0, m: 45 };
    } else {
      const h = Math.min(12, Math.floor(total / 60));
      const m = total % 60;
      tcState[name] = { h, m: tcSnapStep(m, TC_DUR_STEPS) };
    }
  }
  tcRender(name);
}

function tcAdjust(name, part, dir) {
  const s = tcState[name];
  if (name === 'exec-time') {
    if (!s.active) { s.active = true; s.h = 9; s.m = 0; tcRender(name); return; }
    if (part === 'h') {
      s.h = ((s.h + dir) + 24) % 24;
    } else {
      const idx = TC_TIME_STEPS.indexOf(s.m);
      s.m = TC_TIME_STEPS[((idx + dir) + TC_TIME_STEPS.length) % TC_TIME_STEPS.length];
    }
  } else {
    if (part === 'h') {
      s.h = Math.max(0, Math.min(12, s.h + dir));
    } else {
      const idx = TC_DUR_STEPS.indexOf(s.m);
      s.m = TC_DUR_STEPS[((idx + dir) + TC_DUR_STEPS.length) % TC_DUR_STEPS.length];
    }
  }
  tcRender(name);
}

function tcClear(name) {
  if (name === 'exec-time') {
    tcState[name].active = false;
  } else {
    tcState[name] = { h: 0, m: 0 };
  }
  tcRender(name);
}

function openTaskDetail(tab, id) {
  const cached = tabDataCache[tab];
  if (!cached) return;
  const row = cached.rows.find(r => r.data['ID'] === String(id));
  if (!row) return;
  const d = row.data;
  modalContext.detail = { tab, id };

  document.getElementById('detail-name').value            = d['Name'] || '';
  document.getElementById('detail-status').value          = d['Status'] || 'To Do';
  document.getElementById('detail-priority').value        = d['Priority'] || 'Medium';
  document.getElementById('detail-due-date').value        = sheetDateToIso(d['Due_Date'] || '');
  document.getElementById('detail-execution-date').value  = sheetDateToIso(d['Execution_Date'] || '');
  tcInit('exec-time', d['Execution_Time'] || '');
  tcInit('duration',  d['Estimated_Duration'] || '');
  document.getElementById('detail-recurrence').value      = d['Recurrence'] || '';
  document.getElementById('detail-difficulty').value      = d['Difficulty'] || '';
  document.getElementById('detail-stage').value           = d['Stage'] || '';
  document.getElementById('detail-tags').value            = d['Tags'] || '';
  document.getElementById('detail-assigned-to').value     = d['Assigned_To'] || '';
  document.getElementById('detail-energy-level').value    = d['Energy_Level'] || '';
  document.getElementById('detail-external-link').value   = d['External_Link'] || '';
  document.getElementById('detail-notes').value           = d['Notes'] || '';

  openModal('modal-task-detail');
  setTimeout(() => document.getElementById('detail-notes').focus(), 50);
}

async function saveTaskDetail() {
  const { tab, id } = modalContext.detail || {};
  if (!tab || !id) return;
  const updates = {
    Name:               document.getElementById('detail-name').value.trim(),
    Status:             document.getElementById('detail-status').value,
    Priority:           document.getElementById('detail-priority').value,
    Due_Date:           formatDateForSheet(document.getElementById('detail-due-date').value),
    Execution_Date:     formatDateForSheet(document.getElementById('detail-execution-date').value),
    Execution_Time:     document.getElementById('detail-execution-time').value,
    Estimated_Duration: document.getElementById('detail-duration').value.trim(),
    Recurrence:         document.getElementById('detail-recurrence').value.trim(),
    Difficulty:         document.getElementById('detail-difficulty').value.trim(),
    Stage:              document.getElementById('detail-stage').value.trim(),
    Tags:               document.getElementById('detail-tags').value.trim(),
    Assigned_To:        document.getElementById('detail-assigned-to').value.trim(),
    Energy_Level:       document.getElementById('detail-energy-level').value.trim(),
    External_Link:      document.getElementById('detail-external-link').value.trim(),
    Notes:              document.getElementById('detail-notes').value,
  };

  setLoading('detail-save', true);
  try {
    const res = await api(`/api/row/${encodeURIComponent(tab)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ updates }),
    });
    closeModal('modal-task-detail');
    if (res.archived) {
      toast('Done');
      markTaskDone(tab, id);
    } else {
      toast('Task updated');
      await loadTabData(currentTab);
    }
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('detail-save', false);
  }
}

// ─── Done task visual helpers ──────────────────────────────────────────────────
function markTaskDone(tab, id) {
  // Update the cache
  const cached = tabDataCache[tab];
  if (cached) {
    const row = cached.rows.find(r => r.data['ID'] === String(id));
    if (row) row.data['Status'] = 'Done';
  }

  // Update the task row in the DOM
  const taskRow = document.querySelector(`.task-row[data-id="${id}"]`);
  if (taskRow) {
    taskRow.classList.add('task-done');
    const nameSpan = taskRow.querySelector('.task-name');
    if (nameSpan) nameSpan.classList.add('task-name-strike');
    const statusBtn = taskRow.querySelector('.task-status-btn');
    if (statusBtn) {
      statusBtn.textContent = 'Done';
      statusBtn.className = 'badge badge-done task-status-btn';
      statusBtn.dataset.val = 'Done';
    }
  }

  updateProjectProgress(tab, id);
  checkProjectComplete(tab, id);
}

function updateProjectProgress(tab, id) {
  const cached = tabDataCache[tab];
  if (!cached) return;
  const taskRow = cached.rows.find(r => r.data['ID'] === String(id));
  if (!taskRow) return;
  const projectId = taskRow.data['Parent_ID'];
  if (!projectId) return;

  const projTasks = cached.rows.filter(r => r.data['Type'] === 'TASK' && String(r.data['Parent_ID']) === String(projectId));
  const total = projTasks.length;
  const done  = projTasks.filter(r => r.data['Status'] === 'Done').length;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;

  const fill  = document.querySelector(`.project-card[data-id="${projectId}"] .project-progress-fill`);
  const label = document.querySelector(`.project-card[data-id="${projectId}"] .project-progress-label`);
  if (fill)  fill.style.width   = pct + '%';
  if (label) label.textContent  = pct + '%';
}

function checkProjectComplete(tab, id) {
  const cached = tabDataCache[tab];
  if (!cached) return;
  const taskData = cached.rows.find(r => r.data['ID'] === String(id));
  if (!taskData) return;
  const projectId = taskData.data['Parent_ID'];
  if (!projectId) return;

  const projTasks = cached.rows.filter(r => r.data['Type'] === 'TASK' && String(r.data['Parent_ID']) === String(projectId));
  const allDone = projTasks.length > 0 && projTasks.every(r => r.data['Status'] === 'Done');
  if (!allDone) return;

  const card = document.querySelector(`.project-card[data-id="${projectId}"]`);
  if (card) card.remove();
}

function openAddProject(tab) {
  modalContext.project = { tab };
  document.getElementById('project-name').value = '';
  document.getElementById('project-status').value = 'To Do';
  document.getElementById('project-priority').value = 'Medium';
  document.getElementById('project-notes').value = '';
  openModal('modal-project');
  setTimeout(() => document.getElementById('project-name').focus(), 50);
}

function openAddTask(tab, projectId, projectName) {
  modalContext.task = { tab, projectId };
  document.getElementById('task-context-label').textContent = `Project: ${projectName || ''}`;
  document.getElementById('task-name').value = '';
  document.getElementById('task-status').value = 'To Do';
  document.getElementById('task-execution-date').value = '';
  document.getElementById('task-notes').value = '';
  openModal('modal-task');
  setTimeout(() => document.getElementById('task-name').focus(), 50);
}

// ─── Save handlers ────────────────────────────────────────────────────────────
async function saveCapture() {
  const name  = document.getElementById('capture-name').value.trim();
  const notes = document.getElementById('capture-notes').value.trim();
  if (!name) { document.getElementById('capture-name').focus(); return; }

  setLoading('capture-save', true);
  try {
    await api('/api/inbox', { method: 'POST', body: JSON.stringify({ name, notes }) });
    closeModal('modal-capture');
    toast('Saved to Inbox');
    if (currentTab === 'Inbox') await loadTabData('Inbox');
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('capture-save', false);
  }
}

async function saveStatus() {
  const { tab, id } = modalContext.status || {};
  if (!tab || !id) return;
  const status = document.getElementById('status-value').value;

  setLoading('status-save', true);
  try {
    const res = await api(`/api/row/${encodeURIComponent(tab)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ updates: { Status: status } }),
    });
    closeModal('modal-status');
    if (res.archived) {
      toast('Done');
      markTaskDone(tab, id);
    } else {
      toast('Status updated');
      await loadTabData(currentTab);
    }
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('status-save', false);
  }
}

async function saveNotes() {
  const { tab, id } = modalContext.notes || {};
  if (!tab || !id) return;
  const notes = document.getElementById('notes-value').value;

  setLoading('notes-save', true);
  try {
    await api(`/api/row/${encodeURIComponent(tab)}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ updates: { Notes: notes } }),
    });
    closeModal('modal-notes');
    toast('Notes saved');
    await loadTabData(currentTab);
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('notes-save', false);
  }
}

async function saveProject() {
  const { tab } = modalContext.project || {};
  if (!tab) return;
  const name     = document.getElementById('project-name').value.trim();
  const status   = document.getElementById('project-status').value;
  const priority = document.getElementById('project-priority').value;
  const notes    = document.getElementById('project-notes').value.trim();
  if (!name) { document.getElementById('project-name').focus(); return; }

  setLoading('project-save', true);
  try {
    await api(`/api/row/${encodeURIComponent(tab)}`, {
      method: 'POST',
      body: JSON.stringify({ data: { Type: 'PROJECT', Name: name, Status: status, Priority: priority, Notes: notes, Category: tab } }),
    });
    closeModal('modal-project');
    toast('Project created');
    await loadTabData(currentTab);
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('project-save', false);
  }
}

async function saveTask() {
  const { tab, projectId } = modalContext.task || {};
  if (!tab) return;
  const name          = document.getElementById('task-name').value.trim();
  const status        = document.getElementById('task-status').value;
  const executionDate = document.getElementById('task-execution-date').value;
  const notes         = document.getElementById('task-notes').value.trim();
  if (!name) { document.getElementById('task-name').focus(); return; }

  setLoading('task-save', true);
  try {
    await api(`/api/row/${encodeURIComponent(tab)}`, {
      method: 'POST',
      body: JSON.stringify({ data: { Type: 'TASK', Parent_ID: projectId || '', Name: name, Status: status, Priority: 'Medium', Execution_Date: formatDateForSheet(executionDate), Notes: notes, Category: tab } }),
    });
    closeModal('modal-task');
    toast('Task added');
    await loadTabData(currentTab);
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    setLoading('task-save', false);
  }
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Saving...' : btn.dataset.label || btn.textContent;
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function setupEventListeners() {
  // Reload
  document.getElementById('btn-reload').addEventListener('click', async () => {
    if (currentTab) await loadTabData(currentTab);
  });

  // Quick capture
  document.getElementById('btn-quick-capture').addEventListener('click', openCapture);
  document.getElementById('capture-save').addEventListener('click', saveCapture);

  // Status
  document.getElementById('status-save').addEventListener('click', saveStatus);

  // Notes
  document.getElementById('notes-save').addEventListener('click', saveNotes);

  // Project
  document.getElementById('project-save').addEventListener('click', saveProject);

  // Task
  document.getElementById('task-save').addEventListener('click', saveTask);

  // Task detail
  document.getElementById('detail-save').addEventListener('click', saveTaskDetail);

  // Carousels — arrow buttons
  document.querySelectorAll('.tc-btn').forEach(btn =>
    btn.addEventListener('click', () =>
      tcAdjust(btn.dataset.tc, btn.dataset.part, parseInt(btn.dataset.dir, 10))
    )
  );
  document.querySelectorAll('.tc-clear-btn').forEach(btn =>
    btn.addEventListener('click', () => tcClear(btn.dataset.tc))
  );

  // Carousels — drag + scroll
  let tcDrag = null;

  document.querySelectorAll('.tc-unit').forEach(unit => {
    const btn = unit.querySelector('.tc-btn');
    if (!btn) return;
    const name = btn.dataset.tc;
    const part = btn.dataset.part;
    const val  = unit.querySelector('.tc-val');
    if (!val) return;

    const startDrag = y => { tcDrag = { name, part, lastY: y, accum: 0 }; };

    val.addEventListener('mousedown',  e => { e.preventDefault(); startDrag(e.clientY); });
    val.addEventListener('touchstart', e => startDrag(e.touches[0].clientY), { passive: true });

    unit.addEventListener('wheel', e => {
      e.preventDefault();
      tcAdjust(name, part, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  });

  document.addEventListener('mousemove', e => {
    if (!tcDrag) return;
    tcDrag.accum += e.clientY - tcDrag.lastY;
    tcDrag.lastY  = e.clientY;
    const step = 22;
    while (tcDrag.accum <= -step) { tcAdjust(tcDrag.name, tcDrag.part,  1); tcDrag.accum += step; }
    while (tcDrag.accum >=  step) { tcAdjust(tcDrag.name, tcDrag.part, -1); tcDrag.accum -= step; }
  });

  document.addEventListener('touchmove', e => {
    if (!tcDrag) return;
    tcDrag.accum += e.touches[0].clientY - tcDrag.lastY;
    tcDrag.lastY  = e.touches[0].clientY;
    const step = 22;
    while (tcDrag.accum <= -step) { tcAdjust(tcDrag.name, tcDrag.part,  1); tcDrag.accum += step; }
    while (tcDrag.accum >=  step) { tcAdjust(tcDrag.name, tcDrag.part, -1); tcDrag.accum -= step; }
  }, { passive: true });

  document.addEventListener('mouseup',  () => { tcDrag = null; });
  document.addEventListener('touchend', () => { tcDrag = null; });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    window.location.href = '/auth/logout';
  });

  // Close modals via Cancel buttons
  document.querySelectorAll('.modal-cancel').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.modal))
  );

  // Close modals via backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(bd =>
    bd.addEventListener('click', () => bd.closest('.modal').classList.add('hidden'))
  );

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
    // Ctrl/Cmd + K = quick capture
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      openCapture();
    }
  });

  // Enter to submit in single-line inputs inside modals
  document.querySelectorAll('.modal-box input[type="text"]').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const saveBtn = input.closest('.modal-box').querySelector('.btn-primary');
        if (saveBtn) saveBtn.click();
      }
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const me = await api('/api/me');
    if (!me) return; // 401 already handled — login screen shown
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    tabs = await api('/api/tabs') || [];
    renderTabNav();

    if (tabs.length > 0) await switchTab(tabs[0]);

    setupEventListeners();
  } catch {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }
}

init();
