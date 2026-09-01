// ─── Config ───────────────────────────────────────────────────────────────────
var SHEET_ID = '1vUd0RklIvEBeKUbO6JdW68xEXNVmxvqW6tPJAIcukoQ';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.openById(SHEET_ID);
}

// Which columns hold a clock time rather than a date. Typing 09:00 into a
// cell makes Sheets store a time value, which comes back as a Date pinned to
// 1899-12-30 — formatting that as a date yields "1899-12-30" and the calendar
// sync then builds an invalid start. Read those columns as HH:mm instead.
var TIME_COLS = { 'Start_Time': true, 'End_Time': true };

function cellText(header, v) {
  if (v === undefined || v === null) return '';
  if (TIME_COLS[header]) {
    if (v instanceof Date) {
      return ('0' + v.getHours()).slice(-2) + ':' + ('0' + v.getMinutes()).slice(-2);
    }
    // Normalised on the way out so the app's time field, which only accepts
    // HH:mm, is never handed a "9:00" it has to reject silently.
    return hhmm(v);
  }
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}

function sheetToObjects(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  var values  = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var rows    = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    // Skip fully empty rows
    var hasData = row.some(function(cell) { return cell !== '' && cell !== null; });
    if (!hasData) continue;

    var obj = {};
    headers.forEach(function(h, j) { obj[h] = cellText(h, row[j]); });
    rows.push(obj);
  }
  return rows;
}

function getHeaders(sheet) {
  if (sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim(); });
}

function getNextId(sheet) {
  var rows   = sheetToObjects(sheet);
  var maxId  = 0;
  rows.forEach(function(r) {
    var n = parseInt(r['ID'] || '0', 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  return maxId + 1;
}

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function jsonOut(data) {
  var output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ─── doGet ────────────────────────────────────────────────────────────────────
// Returns: { projects: [...], tasks: [...], categories: [...] }
function doGet(e) {
  try {
    var ss         = getSpreadsheet();
    var itemsSheet = ss.getSheetByName('Items');
    var catSheet   = ss.getSheetByName('Categories');

    if (!itemsSheet) return jsonOut({ error: 'Items tab not found' });
    if (!catSheet)   return jsonOut({ error: 'Categories tab not found' });

    var items      = sheetToObjects(itemsSheet);
    var projects   = items.filter(function(r) { return r['Type'] === 'PROJECT'; });
    var tasks      = items.filter(function(r) { return r['Type'] === 'TASK'; });
    var sessions   = items.filter(function(r) { return r['Type'] === 'SESSION'; });
    var categories = sheetToObjects(catSheet);

    return jsonOut({ projects: projects, tasks: tasks, sessions: sessions, categories: categories });
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── doPost ───────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;

    switch (action) {
      case 'addItem':        result = addItem(body);        break;
      case 'updateItem':     result = updateItem(body);     break;
      case 'archiveProject': result = archiveProject(body); break;
      case 'addInbox':       result = addInbox(body);       break;
      case 'reorderProjects':result = reorderRows(body);    break;
      case 'reorderTasks':   result = reorderRows(body);    break;
      case 'deleteTask':     result = deleteTask(body);     break;
      case 'deleteProject':  result = deleteProject(body);  break;
      case 'addCategory':    result = addCategory(body);    break;
      default:               result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

// addItem — appends a new row to Items
// Required body fields: Type (PROJECT, TASK or SESSION), Name
// Optional: Parent_ID, Status, Priority, Category, Due_Date, Start_Time,
//           End_Time, Session_ID, Notes
// A SESSION is a working slot under a project: Parent_ID is the project,
// Due_Date is the day, Start_Time and End_Time bound it. One session row is
// one calendar event.
// The app fires these in parallel — adding four tasks sends four POSTs at
// once. Without a lock each execution reads getNextId() before any of the
// others has appended, so they all claim the same ID. Serialise the
// read-then-append, and flush so the next holder sees the new row.
function addItem(body) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { error: 'Sheet busy, please retry' }; }

  var result;
  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName('Items');
    if (!sheet) return { error: 'Items tab not found' };

    var headers = getHeaders(sheet);
    var newId   = getNextId(sheet);
    var ts      = now();

    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':            return String(newId);
        case 'Created_Date':  return ts;
        case 'Last_Modified': return ts;
        default:              return body[h] !== undefined ? String(body[h]) : '';
      }
    });

    sheet.appendRow(row);
    SpreadsheetApp.flush();
    result = { success: true, id: newId };
  } finally {
    lock.releaseLock();
  }

  // Calendar work stays outside the lock: the Calendar API is slow and the
  // next writer only needs the row to exist, not its event.
  if (body['Parent_ID']) reconcileProject(body['Parent_ID']);
  return result;
}

// updateItem — finds a row by ID in Items and updates specified fields
// Required body fields: id
// Any other fields in body (except action, id) are applied as updates
function updateItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Items');
  if (!sheet) return { error: 'Items tab not found' };

  var targetId = String(body.id);
  var headers  = getHeaders(sheet);
  var lastRow  = sheet.getLastRow();
  if (lastRow < 2) return { error: 'No rows in Items' };

  var idCol    = headers.indexOf('ID') + 1; // 1-based
  if (idCol === 0) return { error: 'ID column not found' };

  var idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  var rowIndex = -1;
  for (var i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0]) === targetId) { rowIndex = i + 2; break; } // +2: header + 0-index
  }
  if (rowIndex === -1) return { error: 'Item not found: ' + targetId };

  // Read existing row values
  var existing = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];

  // Apply updates
  var SKIP = { action: true, id: true };
  headers.forEach(function(h, j) {
    if (h === 'Last_Modified') { existing[j] = now(); return; }
    if (!SKIP[h] && body[h] !== undefined) existing[j] = String(body[h]);
  });

  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([existing]);

  // A project row owns its events; a task or session row points at one.
  var typeIdx   = headers.indexOf('Type');
  var parentIdx = headers.indexOf('Parent_ID');
  var owner = (typeIdx !== -1 && String(existing[typeIdx]).trim() === 'PROJECT')
    ? targetId
    : (parentIdx !== -1 ? String(existing[parentIdx]).trim() : '');
  if (owner) reconcileProject(owner);

  return { success: true, id: targetId };
}

// archiveProject — moves a project and all its tasks from Items to Archive tab.
// Required body fields: project_id
function archiveProject(body) {
  var ss         = getSpreadsheet();
  var itemsSheet = ss.getSheetByName('Items');
  if (!itemsSheet) return { error: 'Items tab not found' };

  var projectId = String(body.project_id || '').trim();
  if (!projectId) return { error: 'Missing project_id' };

  dropProjectEvents(projectId);

  var lastRow = itemsSheet.getLastRow();
  var lastCol = itemsSheet.getLastColumn();
  if (lastRow < 2) return { error: 'No items in sheet' };

  var values  = itemsSheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var idIdx     = headers.indexOf('ID');
  var parentIdx = headers.indexOf('Parent_ID');
  if (idIdx === -1) return { error: 'ID column not found' };

  // Collect matching rows (project + its tasks)
  var toArchive = [];
  for (var i = 1; i < values.length; i++) {
    var rowId   = String(values[i][idIdx]     || '');
    var parentId = parentIdx !== -1 ? String(values[i][parentIdx] || '') : '';
    if (rowId === projectId || parentId === projectId) {
      toArchive.push({ rowIndex: i + 1, vals: values[i] });
    }
  }
  if (toArchive.length === 0) return { error: 'Project not found: ' + projectId };

  // Get or create Archive tab with same headers + Archived_Date
  var archiveSheet = ss.getSheetByName('Archive');
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet('Archive');
    var newHeaders = headers.concat(['Archived_Date']);
    archiveSheet.appendRow(newHeaders);
    archiveSheet.getRange(1, 1, 1, newHeaders.length).setFontWeight('bold');
    archiveSheet.setFrozenRows(1);
  }

  var archHeaders  = getHeaders(archiveSheet);
  var archiveDate  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Append each row to Archive
  toArchive.forEach(function(item) {
    var row = archHeaders.map(function(h) {
      if (h === 'Archived_Date') return archiveDate;
      var idx = headers.indexOf(h);
      return idx !== -1 ? String(item.vals[idx] || '') : '';
    });
    archiveSheet.appendRow(row);
  });

  // Delete from Items in reverse order to preserve row indices
  toArchive.map(function(item) { return item.rowIndex; })
    .sort(function(a, b) { return b - a; })
    .forEach(function(idx) { itemsSheet.deleteRow(idx); });

  return { success: true, archived: toArchive.length };
}

// addInbox — appends a message to the Inbox tab
// Required body fields: message
// Optional: source (defaults to 'app')
function addInbox(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Inbox');
  if (!sheet) return { error: 'Inbox tab not found' };

  var headers = getHeaders(sheet);
  var ts      = now();

  var row = headers.map(function(h) {
    switch (h) {
      case 'Timestamp': return ts;
      case 'Message':   return body.message || '';
      case 'Source':    return body.source  || 'app';
      case 'Processed': return 'FALSE';
      default:          return '';
    }
  });

  sheet.appendRow(row);
  return { success: true };
}

// ─── deleteTask ──────────────────────────────────────────────────────────────
// Hard-deletes a single TASK or SESSION row from Items. No archive.
// Deleting a session drops its calendar event and releases its tasks back to
// unscheduled — the tasks themselves are never touched.
// Required body fields: id
function deleteTask(body) {
  var ss      = getSpreadsheet();
  var sheet   = ss.getSheetByName('Items');
  var headers = getHeaders(sheet);
  var idCol   = headers.indexOf('ID') + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'No rows' };

  var targetId = String(body.id);
  var rows     = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var typeIdx  = headers.indexOf('Type');
  var parIdx   = headers.indexOf('Parent_ID');
  var sessIdx  = headers.indexOf('Session_ID');
  var evIdx    = headers.indexOf('Calendar_Event_ID');

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol - 1]) !== targetId) continue;

    var owner  = parIdx !== -1 ? String(rows[i][parIdx]).trim() : '';
    var isSess = typeIdx !== -1 && String(rows[i][typeIdx]).trim() === 'SESSION';

    if (isSess) {
      if (evIdx !== -1) dropEvent(String(rows[i][evIdx]).trim());
      // release its tasks before the row goes, or they point at nothing
      if (sessIdx !== -1) {
        for (var j = 0; j < rows.length; j++) {
          if (String(rows[j][sessIdx]).trim() === targetId) {
            sheet.getRange(j + 2, sessIdx + 1).setValue('');
          }
        }
      }
    }

    sheet.deleteRow(i + 2);
    if (owner) reconcileProject(owner);
    return { success: true };
  }
  return { error: 'Task not found: ' + targetId };
}

// ─── deleteProject ───────────────────────────────────────────────────────────
// Hard-deletes a project row and every task under it. No archive — use
// archiveProject instead when the rows should be kept.
// Required body fields: project_id
function deleteProject(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Items');
  if (!sheet) return { error: 'Items tab not found' };

  var projectId = String(body.project_id || '').trim();
  if (!projectId) return { error: 'Missing project_id' };

  dropProjectEvents(projectId);

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { error: 'No items in sheet' };

  var values    = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers   = values[0].map(function(h) { return String(h).trim(); });
  var idIdx     = headers.indexOf('ID');
  var parentIdx = headers.indexOf('Parent_ID');
  if (idIdx === -1) return { error: 'ID column not found' };

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var rowId    = String(values[i][idIdx] || '');
    var parentId = parentIdx !== -1 ? String(values[i][parentIdx] || '') : '';
    if (rowId === projectId || parentId === projectId) rows.push(i + 1);
  }
  if (rows.length === 0) return { error: 'Project not found: ' + projectId };

  // Reverse order so earlier deletions do not shift later row indices.
  rows.sort(function(a, b) { return b - a; })
      .forEach(function(idx) { sheet.deleteRow(idx); });

  return { success: true, deleted: rows.length };
}

// ─── addCategory ─────────────────────────────────────────────────────────────
// Appends a row to the Categories tab. Matching on name is case-insensitive,
// so a repeat call returns the existing category rather than duplicating it.
// Required body fields: name
function addCategory(body) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { error: 'Sheet busy, please retry' }; }

  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName('Categories');
    if (!sheet) return { error: 'Categories tab not found' };

    var name = String(body.name || '').trim();
    if (!name) return { error: 'Missing name' };

    var existing = sheetToObjects(sheet);
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i]['Name']).trim().toLowerCase() === name.toLowerCase()) {
        return { success: true, id: existing[i]['ID'], existed: true };
      }
    }

    var headers = getHeaders(sheet);
    var newId   = getNextId(sheet);

    var row = headers.map(function(h) {
      if (h === 'ID')   return String(newId);
      if (h === 'Name') return name;
      return '';
    });

    sheet.appendRow(row);
    SpreadsheetApp.flush();
    return { success: true, id: newId };
  } finally {
    lock.releaseLock();
  }
}

// ─── reorderRows ─────────────────────────────────────────────────────────────
// Shared by reorderProjects and reorderTasks.
// body.ids = array of row IDs in the new desired order.
// Finds those rows in the Items sheet and physically reorders them,
// keeping all other rows untouched.
function reorderRows(body) {
  if (!body || !body.ids || !body.ids.length) return { error: 'Missing ids' };
  var ss      = getSpreadsheet();
  var sheet   = ss.getSheetByName('Items');
  var data    = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var idCol   = headers.indexOf('ID');
  var idOrder = (body.ids || []).map(String);

  // Map each requested ID to its 0-based data index (row 0 = header).
  var rowByID = {};
  for (var i = 1; i < data.length; i++) {
    var rid = String(data[i][idCol]);
    if (idOrder.indexOf(rid) !== -1) rowByID[rid] = i;
  }

  // Slot positions in ascending order (the physical rows we will overwrite).
  var slots = idOrder
    .filter(function(id) { return rowByID[id] !== undefined; })
    .map(function(id)    { return rowByID[id]; })
    .sort(function(a, b) { return a - b; });

  // Row data in the new order.
  var newRows = idOrder
    .filter(function(id) { return rowByID[id] !== undefined; })
    .map(function(id)    { return data[rowByID[id]]; });

  // Write each new row into its slot (sheet row = dataIndex + 1).
  slots.forEach(function(dataIdx, i) {
    sheet.getRange(dataIdx + 1, 1, 1, headers.length).setValues([newRows[i]]);
  });

  return { success: true };
}

// ─── migrateColumns ──────────────────────────────────────────────────────────
// Run once from the editor before the first deployment that syncs calendars.
// Adds the columns the sync needs and retires Estimated_Duration by renaming
// it to Start_Time. Idempotent — a second run reports nothing to do.
function migrateColumns() {
  var ss    = getSpreadsheet();
  var items = ss.getSheetByName('Items');
  var cats  = ss.getSheetByName('Categories');
  if (!items) return 'Items tab not found';
  if (!cats)  return 'Categories tab not found';

  var added   = [];
  var headers = getHeaders(items);

  var oldIdx = headers.indexOf('Estimated_Duration');
  if (oldIdx !== -1 && headers.indexOf('Start_Time') === -1) {
    items.getRange(1, oldIdx + 1).setValue('Start_Time');
    added.push('Items.Estimated_Duration renamed to Start_Time');
    headers = getHeaders(items);
  }

  ['Start_Time', 'End_Time', 'Session_ID', 'Calendar_Event_ID'].forEach(function(h) {
    if (headers.indexOf(h) !== -1) return;
    items.getRange(1, items.getLastColumn() + 1).setValue(h);
    headers = getHeaders(items);
    added.push('Items.' + h);
  });

  if (getHeaders(cats).indexOf('Calendar_ID') === -1) {
    cats.getRange(1, cats.getLastColumn() + 1).setValue('Calendar_ID');
    added.push('Categories.Calendar_ID');
  }

  // Sheets turns "09:00" into a time value, which reads back as a Date on
  // 1899-12-30. Pin both columns to plain text so they stay strings, then
  // rewrite anything already stored as a time.
  headers = getHeaders(items);
  ['Start_Time', 'End_Time'].forEach(function(h) {
    var i = headers.indexOf(h);
    if (i === -1) return;
    items.getRange(1, i + 1, items.getMaxRows()).setNumberFormat('@');

    var last = items.getLastRow();
    if (last < 2) return;
    // Two things to repair: a value still held as a time, and one Sheets has
    // already rendered as text without its leading zero ("9:00").
    var rng  = items.getRange(2, i + 1, last - 1, 1);
    var vals = rng.getValues();
    var hit  = false;
    for (var r = 0; r < vals.length; r++) {
      var was = vals[r][0];
      if (was === '' || was === null) continue;
      var fixed = cellText(h, was);
      if (fixed !== String(was)) { vals[r][0] = fixed; hit = true; }
    }
    if (hit) { rng.setValues(vals); added.push(h + ' repaired'); }
  });

  SpreadsheetApp.flush();
  var msg = added.length ? 'Added: ' + added.join(', ') : 'Nothing to do, already migrated.';
  Logger.log(msg);
  return msg;
}

// ─── Calendar ────────────────────────────────────────────────────────────────
// One SESSION row is one calendar event. Which calendar it lands on comes from
// the project's category: Categories.Calendar_ID holds the calendar address.
// Blank or unrecognised falls back to the account's default calendar, so a new
// category still syncs somewhere rather than failing.

function isDone(status) {
  return String(status || '').trim().toLowerCase() === 'done';
}

// Any of '9:00', '09:00', '09:00:00' → '09:00:00'. Anything else → '', which
// the caller reads as "no time given" and falls back to an all-day event.
// Sheets renders a time value without a leading zero, so 'H:mm' does turn up.
function hms(t) {
  var m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return '';
  var h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return '';
  return ('0' + h).slice(-2) + ':' + m[2] + ':' + (m[3] || '00');
}

// 'H:mm' / 'HH:mm' / 'HH:mm:ss' → 'HH:mm'. Unparseable → ''.
function hhmm(t) {
  var s = hms(t);
  return s ? s.slice(0, 5) : '';
}

function writeCell(sheet, rowIndex, headers, name, value) {
  var i = headers.indexOf(name);
  if (i !== -1) sheet.getRange(rowIndex, i + 1).setValue(value);
}

function categoryCalendarIds() {
  var sheet = getSpreadsheet().getSheetByName('Categories');
  var ids   = [];
  if (!sheet) return ids;
  sheetToObjects(sheet).forEach(function(r) {
    var c = String(r['Calendar_ID'] || '').trim();
    if (c && ids.indexOf(c) === -1) ids.push(c);
  });
  return ids;
}

function calendarForCategory(cat) {
  var wanted = String(cat || '').trim().toLowerCase();
  var sheet  = getSpreadsheet().getSheetByName('Categories');
  var id     = '';
  if (sheet && wanted) {
    sheetToObjects(sheet).forEach(function(r) {
      if (String(r['Name'] || '').trim().toLowerCase() === wanted) {
        id = String(r['Calendar_ID'] || '').trim();
      }
    });
  }
  if (id) {
    var cal = CalendarApp.getCalendarById(id);
    if (cal) return cal;
  }
  return CalendarApp.getDefaultCalendar();
}

// Deletes an event wherever it lives. Changing a project's category moves its
// sessions to a different calendar, and CalendarApp cannot move an event
// between calendars — the old one has to go and a new one takes its place.
function dropEvent(eventId) {
  eventId = String(eventId || '').trim();
  if (!eventId) return;
  var ids = [''].concat(categoryCalendarIds());   // '' = default calendar
  for (var i = 0; i < ids.length; i++) {
    try {
      var cal = ids[i] ? CalendarApp.getCalendarById(ids[i]) : CalendarApp.getDefaultCalendar();
      if (!cal) continue;
      var ev = cal.getEventById(eventId);
      if (ev) { ev.deleteEvent(); return; }
    } catch (_) {}
  }
}

// Every event belonging to a project, used before the rows are deleted or
// archived and there is nothing left to reconcile against.
function dropProjectEvents(projectId) {
  projectId = String(projectId || '').trim();
  if (!projectId) return;
  var sheet = getSpreadsheet().getSheetByName('Items');
  if (!sheet) return;
  sheetToObjects(sheet).forEach(function(r) {
    if (r['Type'] === 'SESSION' && String(r['Parent_ID']).trim() === projectId) {
      dropEvent(r['Calendar_Event_ID']);
    }
  });
}

// ─── reconcileProject ────────────────────────────────────────────────────────
// Rebuilds every calendar event for one project from the sheet. Recomputing
// the lot is cheaper than working out which single row moved, and it self-heals
// after a failed write. An event exists when a session has a date and at least
// one task; its description is that session's tasks as a checklist, so ticking
// one off in the app updates the event.
function reconcileProject(projectId) {
  projectId = String(projectId || '').trim();
  if (!projectId) return;

  var sheet   = getSpreadsheet().getSheetByName('Items');
  if (!sheet) return;
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || headers.indexOf('Calendar_Event_ID') === -1) return;

  var col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  function cell(row, name) {
    var i = col[name];
    return (i === undefined) ? '' : cellText(name, row[i]).trim();
  }

  var values   = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var project  = null, sessions = [], tasks = [];

  values.forEach(function(row, i) {
    var rec = { row: row, rowIndex: i + 2 };
    if (cell(row, 'ID') === projectId && cell(row, 'Type') === 'PROJECT') project = rec;
    else if (cell(row, 'Parent_ID') === projectId) {
      if (cell(row, 'Type') === 'SESSION') sessions.push(rec); else tasks.push(rec);
    }
  });
  if (!project || !sessions.length) return;

  var title = cell(project.row, 'Name') || '(no title)';
  var cal   = calendarForCategory(cell(project.row, 'Category'));

  sessions.forEach(function(s) {
    var sid     = cell(s.row, 'ID');
    var date    = cell(s.row, 'Due_Date');
    var start   = cell(s.row, 'Start_Time');
    var end     = cell(s.row, 'End_Time');
    var eventId = cell(s.row, 'Calendar_Event_ID');
    var mine    = tasks.filter(function(t) { return cell(t.row, 'Session_ID') === sid; });

    // No date, or nothing in it: there should be no event.
    if (!date || !mine.length) {
      if (eventId) {
        dropEvent(eventId);
        writeCell(sheet, s.rowIndex, headers, 'Calendar_Event_ID', '');
      }
      return;
    }

    var desc = mine.map(function(t) {
      return (isDone(cell(t.row, 'Status')) ? '[x] ' : '[ ] ') + cell(t.row, 'Name');
    }).join('\n');

    var ev = null;
    if (eventId) {
      try { ev = cal.getEventById(eventId); } catch (_) {}
      // Not on the target calendar means the category changed, or someone
      // deleted it by hand. Either way the id is stale.
      if (!ev) { dropEvent(eventId); eventId = ''; }
    }

    // A time that will not parse is treated as no time at all, so a bad cell
    // yields an all-day event rather than an event on an invalid date.
    var from0 = hms(start), to0 = hms(end);
    if (from0 && to0) {
      var from = new Date(date + 'T' + from0);
      var to   = new Date(date + 'T' + to0);
      if (ev) {
        ev.setTitle(title); ev.setDescription(desc); ev.setTime(from, to);
      } else {
        ev = cal.createEvent(title, from, to, { description: desc });
      }
    } else {
      var p   = date.split('-');
      var day = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      if (ev) {
        ev.setTitle(title); ev.setDescription(desc);
        if (!ev.isAllDayEvent()) ev.setAllDayDate(day);
      } else {
        ev = cal.createAllDayEvent(title, day, { description: desc });
      }
    }

    if (ev.getId() !== eventId) {
      writeCell(sheet, s.rowIndex, headers, 'Calendar_Event_ID', ev.getId());
    }
  });
}
