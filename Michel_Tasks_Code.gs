// ─── Config ───────────────────────────────────────────────────────────────────
var SHEET_ID = '1vUd0RklIvEBeKUbO6JdW68xEXNVmxvqW6tPJAIcukoQ';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.openById(SHEET_ID);
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
    headers.forEach(function(h, j) {
      var v = row[j];
      if (v instanceof Date) {
        obj[h] = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        obj[h] = (v !== undefined && v !== null) ? String(v) : '';
      }
    });
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
    var categories = sheetToObjects(catSheet);

    return jsonOut({ projects: projects, tasks: tasks, categories: categories });
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
// Required body fields: Type (PROJECT or TASK), Name
// Optional: Parent_ID, Status, Priority, Category, Due_Date, Estimated_Duration, Notes
// The app fires these in parallel — adding four tasks sends four POSTs at
// once. Without a lock each execution reads getNextId() before any of the
// others has appended, so they all claim the same ID. Serialise the
// read-then-append, and flush so the next holder sees the new row.
function addItem(body) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (e) { return { error: 'Sheet busy, please retry' }; }

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
    return { success: true, id: newId };
  } finally {
    lock.releaseLock();
  }
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
// Hard-deletes a single TASK row from Items. No archive.
// Required body fields: id
function deleteTask(body) {
  var ss      = getSpreadsheet();
  var sheet   = ss.getSheetByName('Items');
  var headers = getHeaders(sheet);
  var idCol   = headers.indexOf('ID') + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'No rows' };

  var targetId = String(body.id);
  var idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0]) === targetId) {
      sheet.deleteRow(i + 2);
      return { success: true };
    }
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
