// ─── GAS backend URL & token ──────────────────────────────────────────────────
const GAS_URL   = 'https://script.google.com/macros/s/AKfycbxD-2UFTo2N71FJI9GfhPURYrk2ano3mB4nVLLKCjUzKkP5qjTnLjQ4IulLIfDgVU6s/exec';
const API_TOKEN = 'tm-botte-2026-xK9mP'; // Must match API_TOKEN in GAS Script Properties

// ─── State ────────────────────────────────────────────────────────────────────
let currentTab = null;
let tabs = [];
let modalContext = {}; // Stores context for open modals
let tabDataCache = {}; // Cache of last-loaded data per tab

// ─── API helpers ──────────────────────────────────────────────────────────────
async function gasGet(params) {
  const all = Object.assign({ token: API_TOKEN }, params);
  const qs = Object.entries(all).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${GAS_URL}?${qs}`, { redirect: 'follow' });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error);
  return data;
}

async function gasPost(body) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    // text/plain avoids CORS preflight — GAS parses body via e.postData.contents
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(Object.assign({ token: API_TOKEN }, body)),
    redirect: 'follow',
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error);
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
const FLAT_TABS = new Set(['Inbox', 'Michel_Review', 'Archive', 'Social']);

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

// For hierarchical tabs: fetch main tab + Archive in parallel, merge archived
// tasks whose Parent_ID matches a project still in the main tab.
async function fetchHierarchicalData(tabName) {
  const [mainData, archiveData] = await Promise.all([
    gasGet({ action: 'data', tab: tabName }),
    gasGet({ action: 'data', tab: 'Archive' }),
  ]);

  // Build set of project IDs that are still active (not yet archived)
  const activeProjectIds = new Set(
    mainData.rows
      .filter(r => r.data['Type'] === 'PROJECT')
      .map(r => String(r.data['ID']))
  );

  // Find archived tasks whose parent project is still in the main tab.
  // Force Type='TASK' in case Archive tab doesn't store that column.
  const archivedTasks = archiveData.rows
    .filter(r => {
      const pid = r.data['Parent_ID'];
      return pid && activeProjectIds.has(String(pid));
    })
    .map(r => ({
      rowIndex: r.rowIndex,
      data: { ...r.data, Type: 'TASK', Status: r.data['Status'] || 'Done' },
    }));

  console.log(`[TM] ${tabName}: ${mainData.rows.length} active rows + ${archivedTasks.length} archived tasks`);

  return { headers: mainData.headers, rows: [...mainData.rows, ...archivedTasks] };
}

async function switchTab(tabName) {
  currentTab = tabName;
  renderTabNav();
  const fetchData = () => FLAT_TABS.has(tabName)
    ? gasGet({ action: 'data', tab: tabName })
    : fetchHierarchicalData(tabName);
  if (tabDataCache[tabName]) {
    // Instant render from cache, then silently refresh in background
    renderTabContent(tabName, tabDataCache[tabName]);
    fetchData()
      .then(data => {
        tabDataCache[tabName] = data;
        if (currentTab === tabName) renderTabContent(tabName, data);
      })
      .catch(() => {});
  } else {
    await loadTabData(tabName);
  }
}

async function loadTabData(tabName) {
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="loading"><span class="spinner"></span> Loading...</div>';
  try {
    const data = FLAT_TABS.has(tabName)
      ? await gasGet({ action: 'data', tab: tabName })
      : await fetchHierarchicalData(tabName);
    tabDataCache[tabName] = data;
    renderTabContent(tabName, data);
  } catch (err) {
    main.innerHTML = `<div class="loading">Failed to load: ${esc(err.message)}</div>`;
  }
}

// ─── Render dispatch ──────────────────────────────────────────────────────────
function renderTabContent(tabName, data) {
  const main = document.getElementById('main-content');
  if (tabName === 'Social') {
    renderSocialTab(tabName, data, main);
  } else if (FLAT_TABS.has(tabName)) {
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

  const hasProjSortOrder = projects.some(p => p.data['Sort_Order'] && parseInt(p.data['Sort_Order'], 10) > 0);
  const sortedProjects = hasProjSortOrder
    ? [...projects].sort((a, b) => parseInt(a.data['Sort_Order'] || '0', 10) - parseInt(b.data['Sort_Order'] || '0', 10))
    : projects;

  html += `<div class="projects-list" data-tab="${escAttr(tabName)}">`;

  for (const proj of sortedProjects) {
    const p = proj.data;
    const projTasks = tasks.filter(t => String(t.data['Parent_ID']) === String(p['ID']));
    const totalTasks = projTasks.length;
    const doneTasks  = projTasks.filter(t => t.data['Status'] === 'Done').length;
    const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;
    const hasSortOrder = projTasks.some(t => t.data['Sort_Order'] && parseInt(t.data['Sort_Order'], 10) > 0);
    const sortedTasks = hasSortOrder
      ? [...projTasks].sort((a, b) => parseInt(a.data['Sort_Order'] || '0', 10) - parseInt(b.data['Sort_Order'] || '0', 10))
      : projTasks;

    html += `
      <div class="project-card" data-id="${esc(p['ID'])}" data-tab="${escAttr(tabName)}">
        <div class="project-header" data-project-id="${esc(p['ID'])}">
          <span class="project-drag-handle"></span>
          <span class="project-name">${esc(p['Name'])}</span>
          <div class="project-progress-wrap">
            <div class="project-progress-bar">
              <div class="project-progress-fill" style="width:${pct}%"></div>
            </div>
            <span class="project-progress-label">${pct}%</span>
          </div>
        </div>
        <div class="task-list hidden" id="tl-${esc(p['ID'])}">
          ${sortedTasks.map(t => renderTaskRow(t.data, tabName)).join('')}
          <div class="add-task-row">
            <button class="btn btn-ghost btn-sm btn-add-task" data-tab="${escAttr(tabName)}" data-pid="${esc(p['ID'])}" data-pname="${escAttr(p['Name'])}">+ Add task</button>
          </div>
        </div>
      </div>`;
  }

  html += `</div>`;

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
  // Done tasks are archived — render as read-only (no clickable name or status button)
  const nameEl   = isDone
    ? `<span class="task-name task-name-strike">${esc(d['Name'])}</span>`
    : `<span class="task-name task-name-link" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}">${esc(d['Name'])}</span>`;
  const statusEl = isDone
    ? `<span class="badge ${statusCls}">${esc(d['Status'])}</span>`
    : `<button class="badge ${statusCls} task-status-btn" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}" data-val="${escAttr(d['Status'] || 'To Do')}">${esc(d['Status'] || 'To Do')}</button>`;
  return `
    <div class="task-row${isDone ? ' task-done' : ''}" data-id="${esc(d['ID'])}" data-tab="${escAttr(tabName)}">
      <span class="drag-handle"></span>
      ${nameEl}
      <span class="task-exec-date">${esc(formatDateForDisplay(d['Execution_Date'] || ''))}</span>
      ${statusEl}
    </div>`;
}

function bindHierarchicalEvents(container, tabName) {
  // Project drag handles — stop click from toggling collapse
  container.querySelectorAll('.project-drag-handle').forEach(handle => {
    handle.addEventListener('click', e => e.stopPropagation());
  });

  // Init project-level sortable
  const projectsList = container.querySelector('.projects-list');
  if (projectsList) initProjectSortable(projectsList, tabName);

  // Collapse / expand — click anywhere on header; init Sortable on first expand
  container.querySelectorAll('.project-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const pid = hdr.dataset.projectId;
      const tl = document.getElementById(`tl-${pid}`);
      if (!tl) return;
      const expanding = tl.classList.contains('hidden');
      tl.classList.toggle('hidden');
      if (expanding && !tl._sortable) {
        tl._sortable = initSortable(tl, tabName);
      }
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

// ─── Sortable task reordering ─────────────────────────────────────────────────
function initSortable(taskList, tabName) {
  return Sortable.create(taskList, {
    handle: '.drag-handle',
    draggable: '.task-row',
    animation: 120,
    ghostClass: 'sortable-ghost',
    onEnd: () => saveSortOrder(tabName, taskList),
  });
}

function saveSortOrder(tabName, taskList) {
  const rows = [...taskList.querySelectorAll('.task-row')];
  const orders = rows.map((row, i) => ({ id: row.dataset.id, sortOrder: i + 1 }));
  const cached = tabDataCache[tabName];
  if (cached) {
    orders.forEach(({ id, sortOrder }) => {
      const row = cached.rows.find(r => r.data['ID'] === String(id));
      if (row) row.data['Sort_Order'] = String(sortOrder);
    });
  }
  gasPost({ action: 'updateSortOrder', tab: tabName, orders })
    .catch(() => toast('Failed to save order'));
}

// ─── Sortable project reordering ──────────────────────────────────────────────
function initProjectSortable(projectsList, tabName) {
  return Sortable.create(projectsList, {
    handle: '.project-drag-handle',
    draggable: '.project-card',
    animation: 120,
    ghostClass: 'sortable-ghost',
    onEnd: () => saveProjectSortOrder(tabName, projectsList),
  });
}

function saveProjectSortOrder(tabName, projectsList) {
  const cards = [...projectsList.querySelectorAll('.project-card')];
  const orders = cards.map((card, i) => ({ id: card.dataset.id, sortOrder: i + 1 }));
  const cached = tabDataCache[tabName];
  if (cached) {
    orders.forEach(({ id, sortOrder }) => {
      const row = cached.rows.find(r => r.data['ID'] === String(id) && r.data['Type'] === 'PROJECT');
      if (row) row.data['Sort_Order'] = String(sortOrder);
    });
  }
  gasPost({ action: 'updateSortOrder', tab: tabName, orders })
    .catch(() => toast('Failed to save order'));
}

// ─── Flat tab (Inbox, Michel_Review, Archive) ─────────────────────────────────
function renderFlatTab(tabName, data, container) {
  const { rows } = data;
  let html = '';

  if (tabName === 'Inbox') {
    html += `
      <div class="flat-section-header">
        <button class="btn btn-secondary btn-sm" id="btn-add-inbox">+ Add to Inbox</button>
      </div>`;
  }

  if (rows.length === 0) {
    html += '<div class="empty-state">Nothing here yet.</div>';
  } else if (tabName === 'Michel_Review') {
    for (const row of rows) {
      const d = row.data;
      const id            = d['ID'] || d['Review_ID'] || '';
      const name          = d['Name'] || d['Reference_Name'] || '(no name)';
      const reviewNote    = d['Review_Note'] || d['Notes'] || '';
      const reviewAnswer  = d['Review_Answer'] || '';
      const confirmed     = d['Review_Confirmed'] === 'TRUE';
      const dateVal       = d['Review_Date'] || d['Created_Date'] || '';

      html += `
        <div class="flat-row" data-id="${esc(id)}" data-tab="${escAttr(tabName)}">
          <div class="flat-row-body">
            <div class="flat-row-name">${esc(name)}</div>
            ${reviewNote ? `<div class="flat-row-notes">${esc(reviewNote)}</div>` : ''}
            <textarea class="review-answer-input" data-id="${esc(id)}" rows="2" placeholder="Your answer...">${esc(reviewAnswer)}</textarea>
            <div class="review-row-footer">
              <label class="review-confirmed-label">
                <input type="checkbox" class="review-confirmed-cb" data-id="${esc(id)}"${confirmed ? ' checked' : ''}> Confirmed
              </label>
              <button class="btn btn-primary btn-sm review-save-btn" data-id="${esc(id)}">Save</button>
            </div>
          </div>
          <div class="flat-row-date">${esc(formatDateForDisplay(dateVal))}</div>
        </div>`;
    }
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

  if (tabName === 'Michel_Review') {
    container.querySelectorAll('.review-save-btn').forEach(btn =>
      btn.addEventListener('click', () => saveMichelReviewRow(tabName, btn.dataset.id))
    );
    container.querySelectorAll('.review-confirmed-cb').forEach(cb =>
      cb.addEventListener('change', () => saveMichelReviewRow(tabName, cb.dataset.id))
    );
  } else {
    container.querySelectorAll('.btn-notes').forEach(btn =>
      btn.addEventListener('click', () => openNotes(btn.dataset.tab, btn.dataset.id, btn.dataset.val))
    );
  }
}

// ─── Social tab (flat individual tasks) ───────────────────────────────────────
function renderSocialTab(tabName, data, container) {
  const { rows } = data;

  let html = `
    <div class="tab-toolbar">
      <button class="btn btn-secondary btn-sm btn-add-social-task" data-tab="${escAttr(tabName)}">+ Add Task</button>
    </div>`;

  if (rows.length === 0) {
    html += '<div class="empty-state">No tasks yet. Add your first task above.</div>';
  } else {
    const hasSortOrder = rows.some(r => r.data['Sort_Order'] && parseInt(r.data['Sort_Order'], 10) > 0);
    const sorted = hasSortOrder
      ? [...rows].sort((a, b) => parseInt(a.data['Sort_Order'] || '0', 10) - parseInt(b.data['Sort_Order'] || '0', 10))
      : rows;
    html += `<div class="task-list" id="social-task-list">`;
    html += sorted.map(r => renderTaskRow(r.data, tabName)).join('');
    html += `</div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.task-name-link').forEach(span =>
    span.addEventListener('click', () => openTaskDetail(span.dataset.tab, span.dataset.id))
  );
  container.querySelectorAll('.task-status-btn').forEach(btn =>
    btn.addEventListener('click', () => openStatus(btn.dataset.tab, btn.dataset.id, btn.dataset.val))
  );
  container.querySelector('.btn-add-social-task')?.addEventListener('click', () =>
    openAddTask(tabName, '', '')
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
  document.getElementById('detail-external-link').value   = d['External_Link'] || '';
  document.getElementById('detail-notes').value           = d['Notes'] || '';

  openModal('modal-task-detail');

  // Prevent keyboard from appearing on mobile until user taps a field
  document.querySelectorAll('#modal-task-detail input[type="text"], #modal-task-detail input[type="url"], #modal-task-detail textarea').forEach(el => {
    el.setAttribute('readonly', 'readonly');
    el.addEventListener('click', function unlock() {
      el.removeAttribute('readonly');
      el.removeEventListener('click', unlock);
    });
  });
}

function saveTaskDetail() {
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
    External_Link:      document.getElementById('detail-external-link').value.trim(),
    Notes:              document.getElementById('detail-notes').value,
  };

  const cached = tabDataCache[tab];
  const row = cached?.rows.find(r => r.data['ID'] === String(id));
  const oldData = row ? { ...row.data } : null;

  // Optimistic: close modal and apply changes immediately
  closeModal('modal-task-detail');
  if (row) Object.assign(row.data, updates);
  applyTaskRowToDOM(id, updates);
  if (updates.Status === 'Done' && oldData?.Status !== 'Done') {
    updateProjectProgress(tab, id);
    checkProjectComplete(tab, id);
  }

  gasPost({ action: 'updateRow', tab, id, updates })
    .catch(() => {
      if (row && oldData) Object.assign(row.data, oldData);
      toast('Save failed — reloading');
      loadTabData(currentTab);
    });
}

// ─── Done task visual helpers ──────────────────────────────────────────────────
function markTaskDone(tab, id) {
  const cached = tabDataCache[tab];
  if (cached) {
    const row = cached.rows.find(r => r.data['ID'] === String(id));
    if (row) row.data['Status'] = 'Done';
  }

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

// ─── Optimistic UI helpers ────────────────────────────────────────────────────
function setTaskStatusInDOM(id, status) {
  const cls = {
    'Inbox': 'badge-inbox', 'To Do': 'badge-todo',
    'In Progress': 'badge-inprogress', 'Blocked': 'badge-blocked', 'Done': 'badge-done',
  }[status] || 'badge-todo';
  const btn = document.querySelector(`.task-status-btn[data-id="${id}"]`);
  if (btn) {
    btn.textContent = status;
    btn.className = `badge ${cls} task-status-btn`;
    btn.dataset.val = status;
  }
  const row = document.querySelector(`.task-row[data-id="${id}"]`);
  if (row) {
    row.classList.toggle('task-done', status === 'Done');
    row.querySelector('.task-name')?.classList.toggle('task-name-strike', status === 'Done');
  }
}

function applyTaskRowToDOM(id, data) {
  const row = document.querySelector(`.task-row[data-id="${id}"]`);
  if (!row) return;
  if (data.Name !== undefined) {
    const nameSpan = row.querySelector('.task-name');
    if (nameSpan) nameSpan.textContent = data.Name;
  }
  if (data.Execution_Date !== undefined) {
    const dateSpan = row.querySelector('.task-exec-date');
    if (dateSpan) dateSpan.textContent = formatDateForDisplay(data.Execution_Date || '');
  }
  if (data.Status !== undefined) setTaskStatusInDOM(id, data.Status);
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
  const label = document.getElementById('task-context-label');
  if (projectName) {
    label.textContent = `Project: ${projectName}`;
    label.style.display = '';
  } else {
    label.textContent = '';
    label.style.display = 'none';
  }
  document.getElementById('task-name').value = '';
  document.getElementById('task-status').value = 'To Do';
  document.getElementById('task-execution-date').value = '';
  document.getElementById('task-notes').value = '';
  openModal('modal-task');
  setTimeout(() => document.getElementById('task-name').focus(), 50);
}

// ─── Save handlers ────────────────────────────────────────────────────────────
function saveCapture() {
  const name  = document.getElementById('capture-name').value.trim();
  const notes = document.getElementById('capture-notes').value.trim();
  if (!name) { document.getElementById('capture-name').focus(); return; }

  const tempId = 'temp-' + Date.now();
  closeModal('modal-capture');
  toast('Saved to Inbox');

  if (currentTab === 'Inbox') {
    const container = document.getElementById('main-content');
    const header = container.querySelector('.flat-section-header');
    const rowHtml = `
      <div class="flat-row" data-id="${esc(tempId)}">
        <div class="flat-row-body">
          <div class="flat-row-name">${esc(name)}</div>
          ${notes ? `<div class="flat-row-notes">${esc(notes)}</div>` : ''}
        </div>
        <div class="flat-row-date"></div>
        <div class="flat-row-actions">
          <button class="btn btn-ghost btn-sm btn-notes" data-id="${esc(tempId)}" data-val="${escAttr(notes)}">Notes</button>
        </div>
      </div>`;
    if (header) header.insertAdjacentHTML('afterend', rowHtml);
    else container.insertAdjacentHTML('beforeend', rowHtml);
  }

  gasPost({ action: 'inbox', name, notes })
    .then(() => { if (currentTab === 'Inbox') loadTabData('Inbox'); })
    .catch(() => {
      document.querySelector(`.flat-row[data-id="${tempId}"]`)?.remove();
      toast('Save failed — not saved to Inbox');
    });
}

function saveStatus() {
  const { tab, id } = modalContext.status || {};
  if (!tab || !id) return;
  const newStatus = document.getElementById('status-value').value;

  const cached = tabDataCache[tab];
  const row = cached?.rows.find(r => r.data['ID'] === String(id));
  const oldStatus = row?.data?.Status;

  closeModal('modal-status');
  if (row) row.data['Status'] = newStatus;
  setTaskStatusInDOM(id, newStatus);
  if (newStatus === 'Done') {
    updateProjectProgress(tab, id);
    checkProjectComplete(tab, id);
  }

  gasPost({ action: 'updateRow', tab, id, updates: { Status: newStatus } })
    .catch(() => {
      if (row) row.data['Status'] = oldStatus;
      toast('Save failed — reloading');
      loadTabData(currentTab);
    });
}

function saveNotes() {
  const { tab, id } = modalContext.notes || {};
  if (!tab || !id) return;
  const notes = document.getElementById('notes-value').value;

  const cached = tabDataCache[tab];
  const row = cached?.rows.find(r => String(r.data['ID'] || r.data['Review_ID']) === String(id));
  const oldNotes = row?.data?.Notes;

  closeModal('modal-notes');
  if (row) row.data['Notes'] = notes;
  const notesEl = document.querySelector(`.flat-row[data-id="${id}"] .flat-row-notes`);
  if (notesEl) notesEl.textContent = notes;
  toast('Notes saved');

  gasPost({ action: 'updateRow', tab, id, updates: { Notes: notes } })
    .catch(() => {
      if (row) row.data['Notes'] = oldNotes;
      toast('Save failed — reverted');
    });
}

function saveMichelReviewRow(tab, id) {
  const rowEl = document.querySelector(`.flat-row[data-id="${id}"][data-tab="${tab}"]`);
  if (!rowEl) return;
  const answer    = rowEl.querySelector('.review-answer-input')?.value ?? '';
  const confirmed = rowEl.querySelector('.review-confirmed-cb')?.checked ? 'TRUE' : 'FALSE';

  const cached = tabDataCache[tab];
  const row = cached?.rows.find(r => String(r.data['ID'] || r.data['Review_ID']) === String(id));
  if (row) {
    row.data['Review_Answer']    = answer;
    row.data['Review_Confirmed'] = confirmed;
  }

  gasPost({ action: 'updateRow', tab, id, updates: { Review_Answer: answer, Review_Confirmed: confirmed } })
    .then(() => toast('Saved'))
    .catch(() => toast('Save failed'));
}

function saveProject() {
  const { tab } = modalContext.project || {};
  if (!tab) return;
  const name     = document.getElementById('project-name').value.trim();
  const status   = document.getElementById('project-status').value;
  const priority = document.getElementById('project-priority').value;
  const notes    = document.getElementById('project-notes').value.trim();
  if (!name) { document.getElementById('project-name').focus(); return; }

  const tempId = 'temp-' + Date.now();
  closeModal('modal-project');
  toast('Project created');

  document.getElementById('main-content').insertAdjacentHTML('beforeend', `
    <div class="project-card" data-id="${esc(tempId)}" data-tab="${escAttr(tab)}">
      <div class="project-header" data-project-id="${esc(tempId)}">
        <span class="project-name">${esc(name)}</span>
        <div class="project-progress-wrap">
          <div class="project-progress-bar"><div class="project-progress-fill" style="width:0%"></div></div>
          <span class="project-progress-label">0%</span>
        </div>
      </div>
      <div class="task-list hidden" id="tl-${esc(tempId)}"></div>
    </div>`);

  gasPost({ action: 'addRow', tab, data: { Type: 'PROJECT', Name: name, Status: status, Priority: priority, Notes: notes, Category: tab } })
    .then(() => loadTabData(currentTab))
    .catch(() => {
      document.querySelector(`.project-card[data-id="${tempId}"]`)?.remove();
      toast('Save failed — project not created');
    });
}

function saveTask() {
  const { tab, projectId } = modalContext.task || {};
  if (!tab) return;
  const name          = document.getElementById('task-name').value.trim();
  const status        = document.getElementById('task-status').value;
  const executionDate = document.getElementById('task-execution-date').value;
  const notes         = document.getElementById('task-notes').value.trim();
  if (!name) { document.getElementById('task-name').focus(); return; }

  const tempId  = 'temp-' + Date.now();
  const cls     = { 'To Do': 'badge-todo', 'In Progress': 'badge-inprogress', 'Blocked': 'badge-blocked' }[status] || 'badge-todo';
  const dateStr = formatDateForSheet(executionDate);

  closeModal('modal-task');
  toast('Task added');

  const taskList = projectId ? document.getElementById(`tl-${projectId}`) : null;
  if (taskList) {
    taskList.classList.remove('hidden');
    const addRow = taskList.querySelector('.add-task-row');
    const rowHtml = `
      <div class="task-row" data-id="${esc(tempId)}" data-tab="${escAttr(tab)}">
        <span class="task-name task-name-link" data-id="${esc(tempId)}" data-tab="${escAttr(tab)}">${esc(name)}</span>
        <span class="task-exec-date">${esc(formatDateForDisplay(dateStr))}</span>
        <button class="badge ${cls} task-status-btn" data-id="${esc(tempId)}" data-tab="${escAttr(tab)}" data-val="${escAttr(status)}">${esc(status)}</button>
      </div>`;
    if (addRow) addRow.insertAdjacentHTML('beforebegin', rowHtml);
    else taskList.insertAdjacentHTML('beforeend', rowHtml);
  }

  gasPost({ action: 'addRow', tab, data: { Type: 'TASK', Parent_ID: projectId || '', Name: name, Status: status, Priority: 'Medium', Execution_Date: dateStr, Notes: notes, Category: tab } })
    .then(() => loadTabData(currentTab))
    .catch(() => {
      document.querySelector(`.task-row[data-id="${tempId}"]`)?.remove();
      toast('Save failed — task not added');
    });
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
    const allTabs = await gasGet({ action: 'tabs' });
    // Strip internal health/data tabs — they are not task tabs
    tabs = allTabs.filter(t => !['Health_Activities', 'Health_Log', 'INDEX'].includes(t));
    renderTabNav();
    if (tabs.length > 0) await switchTab(tabs[0]);
    setupEventListeners();
    setupBottomNav();
    // Prefetch task tabs in background
    tabs.forEach(tab => {
      if (tabDataCache[tab]) return;
      const fetch = FLAT_TABS.has(tab)
        ? gasGet({ action: 'data', tab })
        : fetchHierarchicalData(tab);
      fetch.then(data => { tabDataCache[tab] = data; }).catch(() => {});
    });
    // Prefetch health data in background
    gasGet({ action: 'getHealthData' }).then(data => { healthData = data; }).catch(() => {});
  } catch (err) {
    document.getElementById('main-content').innerHTML =
      `<div class="loading">Failed to connect to backend: ${esc(err.message)}</div>`;
  }
}

init();

// ─── App-level tab switching (TASKS / HEALTH / FINANCE / GROCERY) ─────────────
let currentAppTab = 'tasks';
let healthData    = null;

const DAY_SUN_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateToISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMondayOfWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + offset);
  return d;
}

function getSundayOfWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // d.getDay() === 0 → stays, else subtract
  return d;
}

function getCategoryIcon(category) {
  const c = (category || '').toUpperCase();
  if (c === 'MOBILITY')
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>`;
  if (c === 'STRENGTH')
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.57 14.86L22 13.43 20.57 12 17 15.57 8.43 7 12 3.43 10.57 2 9.14 3.43 7.71 2 5.57 4.14 4.14 2.71 2.71 4.14l1.43 1.43L2 7.71l1.43 1.43L2 10.57 3.43 12 7 8.43 15.57 17 12 20.57 13.43 22l1.43-1.43L16.29 22l2.14-2.14 1.43 1.43 1.43-1.43-1.43-1.43L22 16.29l-1.43-1.43z"/></svg>`;
  if (c === 'CARDIO')
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/></svg>`;
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>`;
}

function setupBottomNav() {
  document.querySelectorAll('.bottom-tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchAppTab(btn.dataset.appTab))
  );
}

function switchAppTab(appTab) {
  currentAppTab = appTab;
  document.querySelectorAll('.bottom-tab-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.appTab === appTab)
  );
  const sheetNav = document.getElementById('tab-nav');
  if (appTab === 'tasks') {
    sheetNav.style.display = '';
    if (currentTab && tabDataCache[currentTab]) renderTabContent(currentTab, tabDataCache[currentTab]);
    else if (tabs.length > 0) switchTab(tabs[0]);
  } else if (appTab === 'health') {
    sheetNav.style.display = 'none';
    loadHealthTab();
  } else {
    sheetNav.style.display = 'none';
    const label = appTab === 'finance' ? 'FINANCE' : 'GROCERY';
    document.getElementById('main-content').innerHTML =
      `<div class="placeholder-tab">${label}<br><br>COMING SOON</div>`;
  }
}

// ─── Health data fetch ────────────────────────────────────────────────────────
async function loadHealthTab() {
  const main = document.getElementById('main-content');
  if (healthData) renderHealthTab(healthData); // instant render from cache
  else main.innerHTML = '<div class="loading"><span class="spinner"></span> Loading...</div>';
  try {
    const data = await gasGet({ action: 'getHealthData' });
    healthData = data;
    if (currentAppTab === 'health') renderHealthTab(data);
  } catch (err) {
    if (!healthData && currentAppTab === 'health')
      main.innerHTML = `<div class="loading">Failed to load health data: ${esc(err.message)}</div>`;
  }
}

// ─── Health tab rendering ─────────────────────────────────────────────────────
function renderHealthTab(data) {
  const main   = document.getElementById('main-content');
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = dateToISO(today);
  const FULL_DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayFullDay = FULL_DAYS[today.getDay()].toUpperCase();

  // ── Progress bar ─────────────────────────────────────────────────────────────
  const totalSessions     = data.activities
    .filter(a => a.status === 'active' && a.days)
    .reduce((sum, a) => sum + a.days.split(',').length, 0);
  const completedSessions = data.weekLog.filter(e => e.completed).length;
  const remaining         = Math.max(0, totalSessions - completedSessions);
  const pct               = totalSessions > 0 ? Math.round(completedSessions / totalSessions * 100) : 0;

  let progressBar = '';
  for (let i = 0; i < Math.max(totalSessions, 1); i++) {
    progressBar += `<div class="health-progress-seg${i < completedSessions ? ' filled' : ''}"></div>`;
  }

  // ── TODAY cards ───────────────────────────────────────────────────────────────
  const todayActivities = data.activities.filter(a => data.todayScheduled.includes(a.id));
  let todayHtml = todayActivities.length === 0
    ? '<div class="health-card-empty">NO SESSIONS SCHEDULED TODAY</div>'
    : todayActivities.map(act => {
        const done      = data.todayCompleted.includes(act.id);
        const streak    = data.streaks[act.id] || 0;
        const daysLabel = act.days ? act.days.split(',').map(d => d.trim()).join(' · ') : '—';
        return `
          <div class="health-card health-card-today" id="hcard-${act.id}">
            <div class="health-icon-circle health-icon-today">${getCategoryIcon(act.category)}</div>
            <div class="health-card-body">
              <div class="health-card-name">${esc(act.name)}</div>
              <div class="health-card-meta">${esc(act.category)} · ${esc(daysLabel)}</div>
            </div>
            <div class="health-streak-block">
              <div class="health-streak-lbl">STREAK</div>
              <div class="health-streak-num">${String(streak).padStart(2,'0')}</div>
            </div>
            <button class="health-check-btn${done ? ' checked' : ''}"
                    data-activity-id="${escAttr(act.id)}"
                    data-date="${todayStr}"
                    data-completed="${done}">${done ? '✓' : ''}</button>
          </div>`;
      }).join('');

  // ── COMING UP ─────────────────────────────────────────────────────────────────
  const upcoming = getUpcomingSessions(data, today);
  const upcomingHtml = upcoming.length === 0
    ? '<div class="health-card-empty">—</div>'
    : upcoming.map(({ activity: act, date, dayName }) => {
        const streak   = data.streaks[act.id] || 0;
        const dayLabel = `${dayName.toUpperCase()} ${date.getDate()}`;
        return `
          <div class="health-card health-card-upcoming">
            <div class="health-icon-circle health-icon-upcoming">${getCategoryIcon(act.category)}</div>
            <div class="health-card-body">
              <div class="health-card-name health-name-accent">${esc(act.name)}</div>
              <div class="health-card-day-label">${esc(act.category)} · ${esc(dayLabel)}</div>
            </div>
            <div class="health-streak-block">
              <div class="health-streak-lbl health-streak-lbl-dark">STREAK</div>
              <div class="health-streak-num health-streak-num-dark">${String(streak).padStart(2,'0')}</div>
            </div>
            <button class="health-check-btn health-check-btn-outline"
                    data-activity-id="${escAttr(act.id)}"
                    data-date="${dateToISO(date)}"
                    data-completed="false"></button>
          </div>`;
      }).join('');

  // ── LOCKED ────────────────────────────────────────────────────────────────────
  const lockedActivities = data.activities.filter(a => a.status === 'locked');
  let lockedHtml = '';
  lockedActivities.forEach(act => {
    const match = act.unlock_condition ? act.unlock_condition.match(/^(\w+)_streak>=(\d+)$/) : null;
    if (match) {
      const refId     = match[1];
      const threshold = match[2];
      const current   = data.streaks[refId] || 0;
      lockedHtml += `
        <div class="health-card health-card-locked">
          <div class="health-icon-circle health-icon-locked">${getCategoryIcon(act.category)}</div>
          <div class="health-card-body">
            <div class="health-card-name">${esc(act.name)}</div>
            <div class="health-card-meta">${esc(act.category)}</div>
          </div>
          <div class="health-locked-info">
            <div class="health-locked-line1">UNLOCK AT ${esc(threshold)}</div>
            <div class="health-locked-line2">${esc(refId)} streak</div>
            <div class="health-locked-progress">${esc(String(current))} / ${esc(threshold)}</div>
          </div>
          <span class="health-lock-icon">🔒</span>
        </div>`;
    }
  });

  // ── Consistency grid (Sun → Sat) ──────────────────────────────────────────────
  const sunday    = getSundayOfWeek();
  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    weekDates.push(d);
  }
  const GRID_LABELS = ['S','M','T','W','T','F','S'];

  const logLookup = {};
  data.weekLog.forEach(e => { logLookup[`${e.date}|${e.activity_id}`] = e.completed; });

  const gridHead = '<th class="activity-label"></th>' +
    weekDates.map((d, i) => {
      const isToday = dateToISO(d) === todayStr;
      return `<th${isToday ? ' class="today-col"' : ''}>${GRID_LABELS[i]}</th>`;
    }).join('');

  const gridRows = data.activities.map(act => {
    const scheduledDays = act.days ? act.days.split(',').map(d => d.trim()) : [];
    const cells = weekDates.map(d => {
      const ds          = dateToISO(d);
      const dayName     = DAY_SUN_FIRST[d.getDay()];
      const isScheduled = scheduledDays.includes(dayName);
      const isDone      = logLookup[`${ds}|${act.id}`] === true;
      const isFuture    = ds >= todayStr;
      let cls = 'grid-cell ';
      if (act.status === 'locked')  cls += 'locked';
      else if (isScheduled)         cls += isDone ? 'done' : isFuture ? 'scheduled-future' : 'scheduled-missed';
      else                          cls += 'rest';
      return `<td><span class="${cls}"></span></td>`;
    }).join('');
    return `<tr>
      <td class="activity-label">${esc(act.name.slice(0,9).toLowerCase())}</td>
      ${cells}
    </tr>`;
  }).join('');

  // ── Assemble ──────────────────────────────────────────────────────────────────
  main.innerHTML = `
    <div class="health-screen">
      <div class="health-title">HEALTH TRACKER</div>
      <div class="health-progress-header">
        <span class="health-progress-title">WEEKLY PROGRESS</span>
        <span class="health-progress-pct">${pct}%</span>
      </div>
      <div class="health-progress-bar">${progressBar}</div>
      <div class="health-progress-counts">
        <span>${String(completedSessions).padStart(2,'0')} COMPLETED</span>
        <span>${String(remaining).padStart(2,'0')} REMAINING</span>
      </div>

      <div class="health-section-label">TODAY — ${todayFullDay}</div>
      ${todayHtml}

      <div class="health-section-label">COMING UP</div>
      ${upcomingHtml}

      ${lockedActivities.length > 0 ? `<div class="health-section-label">LOCKED</div>${lockedHtml}` : ''}

      <div class="health-section-label">CONSISTENCY GRID</div>
      <table class="health-grid">
        <thead><tr>${gridHead}</tr></thead>
        <tbody>${gridRows}</tbody>
      </table>
    </div>`;

  main.querySelectorAll('.health-check-btn').forEach(btn =>
    btn.addEventListener('click', () => handleHealthCheck(btn))
  );
}

function getUpcomingSessions(data, today) {
  const sessions = [];
  data.activities
    .filter(a => a.status === 'active' && a.days)
    .forEach(act => {
      const scheduledDays = act.days.split(',').map(d => d.trim());
      for (let i = 1; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        if (scheduledDays.includes(DAY_SUN_FIRST[d.getDay()])) {
          sessions.push({ activity: act, date: d, dayName: DAY_SUN_FIRST[d.getDay()] });
          break;
        }
      }
    });
  sessions.sort((a, b) => a.date - b.date);
  return sessions.slice(0, 2);
}

async function handleHealthCheck(btn) {
  const activityId  = btn.dataset.activityId;
  const date        = btn.dataset.date;
  const wasCompleted = btn.dataset.completed === 'true';
  const nowCompleted = !wasCompleted;

  // Optimistic UI update
  btn.disabled = true;
  btn.dataset.completed = String(nowCompleted);
  btn.classList.toggle('checked', nowCompleted);
  btn.textContent = nowCompleted ? '✓' : '';

  // Update local cache so instant re-render is correct
  if (healthData) {
    if (nowCompleted && !healthData.todayCompleted.includes(activityId))
      healthData.todayCompleted.push(activityId);
    else if (!nowCompleted)
      healthData.todayCompleted = healthData.todayCompleted.filter(id => id !== activityId);
    const logEntry = healthData.weekLog.find(e => e.date === date && e.activity_id === activityId);
    if (logEntry) logEntry.completed = nowCompleted;
    else healthData.weekLog.push({ date, activity_id: activityId, completed: nowCompleted });
  }

  try {
    await gasPost({ action: 'logActivity', activityId, date, completed: nowCompleted });
    // Refresh to get updated streaks
    const fresh = await gasGet({ action: 'getHealthData' });
    healthData = fresh;
    if (currentAppTab === 'health') renderHealthTab(fresh);
  } catch (err) {
    // Revert optimistic update
    if (healthData) {
      if (wasCompleted && !healthData.todayCompleted.includes(activityId))
        healthData.todayCompleted.push(activityId);
      else if (!wasCompleted)
        healthData.todayCompleted = healthData.todayCompleted.filter(id => id !== activityId);
      const logEntry = healthData.weekLog.find(e => e.date === date && e.activity_id === activityId);
      if (logEntry) logEntry.completed = wasCompleted;
    }
    btn.disabled = false;
    btn.dataset.completed = String(wasCompleted);
    btn.classList.toggle('checked', wasCompleted);
    btn.textContent = wasCompleted ? '✓' : '';
    toast('Failed to save — try again');
  }
}
