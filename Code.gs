// ─── Config ───────────────────────────────────────────────────────────────────
var SPREADSHEET_ID = '1G7YuPbvHI-txCjJaAL-RlBjfm_LTM3538ZHIbVUyJkg';

// ─── Token auth ───────────────────────────────────────────────────────────────
// Set your token in GAS → Project Settings → Script Properties → API_TOKEN
function isAuthorized(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  return expected && token === expected;
}

// ─── Entry points ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    if (!isAuthorized(e.parameter.token)) return jsonResponse({ error: 'Unauthorized' });
    var action = e.parameter.action;
    var result;
    switch (action) {
      case 'tabs': result = getTabs(); break;
      case 'data': result = getData(e.parameter.tab); break;
      default:     result = { error: 'Unknown action: ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!isAuthorized(body.token)) return jsonResponse({ error: 'Unauthorized' });
    var result;
    switch (body.action) {
      case 'addRow':         result = addRow(body.tab, body.data); break;
      case 'updateRow':      result = updateRowAction(body.tab, body.id, body.updates); break;
      case 'deleteRow':      result = deleteRowAction(body.tab, body.id); break;
      case 'inbox':          result = addInbox(body.name, body.notes); break;
      case 'updateSortOrder': result = updateSortOrder(body.tab, body.orders); break;
      default:               result = { error: 'Unknown action: ' + body.action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.toString() });
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Sheet helpers ────────────────────────────────────────────────────────────
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getTabs() {
  return getSpreadsheet().getSheets().map(function(s) { return s.getName(); });
}

function getData(tabName) {
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return { headers: [], rows: [] };

  var allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = allValues[0].map(function(h) { return String(h); });

  var dataRows = [];
  for (var i = 1; i < allValues.length; i++) {
    var row = allValues[i];
    var data = {};
    var hasData = false;
    headers.forEach(function(h, j) {
      var val = row[j];
      if (val instanceof Date) {
        var dd = String(val.getDate()).padStart(2, '0');
        var mm = String(val.getMonth() + 1).padStart(2, '0');
        val = dd + '-' + mm + '-' + val.getFullYear();
      } else {
        val = (val !== undefined && val !== null) ? String(val) : '';
      }
      data[h] = val;
      if (val !== '') hasData = true;
    });
    if (hasData) dataRows.push({ rowIndex: i + 1, data: data });
  }
  return { headers: headers, rows: dataRows };
}

function today() {
  var d = new Date();
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '-' + mm + '-' + d.getFullYear();
}

function getNextId(tabName) {
  var result = getData(tabName);
  var headers = result.headers;
  var rows = result.rows;
  var idField = headers.indexOf('ID') !== -1 ? 'ID' : 'Review_ID';
  var maxId = 0;
  rows.forEach(function(row) {
    var n = parseInt(row.data[idField] || '0', 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  return maxId + 1;
}

function findRowById(tabName, id) {
  var result = getData(tabName);
  var headers = result.headers;
  var rows = result.rows;
  var idField = headers.indexOf('ID') !== -1 ? 'ID' : 'Review_ID';
  var found = null;
  rows.forEach(function(row) {
    if (String(row.data[idField]) === String(id)) found = row;
  });
  return found ? { rowIndex: found.rowIndex, data: found.data, headers: headers } : null;
}

function appendRowData(tabName, headers, rowData) {
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  var values = headers.map(function(h) { return rowData[h] !== undefined ? rowData[h] : ''; });
  sheet.appendRow(values);
}

function updateRowData(tabName, rowIndex, headers, rowData) {
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  var values = headers.map(function(h) { return rowData[h] !== undefined ? rowData[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, values.length).setValues([values]);
}

function deleteRowData(tabName, rowIndex) {
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error('Tab not found: ' + tabName);
  sheet.deleteRow(rowIndex);
}

// ─── API actions ──────────────────────────────────────────────────────────────
function addRow(tabName, rowData) {
  var result = getData(tabName);
  var headers = result.headers;
  var idField = headers.indexOf('ID') !== -1 ? 'ID' : 'Review_ID';
  rowData[idField] = String(getNextId(tabName));

  var t = today();
  if (headers.indexOf('Created_Date') !== -1 && !rowData['Created_Date']) rowData['Created_Date'] = t;
  if (headers.indexOf('Last_Modified') !== -1) rowData['Last_Modified'] = t;

  appendRowData(tabName, headers, rowData);

  // Calendar sync for new rows with Execution_Date
  if (rowData['Execution_Date'] && tabName !== 'Inbox' && tabName !== 'Michel_Review') {
    var found = findRowById(tabName, rowData[idField]);
    if (found) syncCalendar(found.data, tabName, found.rowIndex, found.headers);
  }

  return { success: true, id: rowData[idField] };
}

function updateRowAction(tabName, id, updates) {
  var found = findRowById(tabName, id);
  if (!found) return { error: 'Row not found' };

  var rowIndex = found.rowIndex;
  var existing = found.data;
  var headers  = found.headers;

  var updated = {};
  Object.keys(existing).forEach(function(k) { updated[k] = existing[k]; });
  Object.keys(updates).forEach(function(k) { updated[k] = updates[k]; });
  updated['Last_Modified'] = today();

  // Archive when Done
  if (updates.Status === 'Done' && existing.Status !== 'Done') {
    updated['Completed_Date'] = today();
    var archResult = getData('Archive');
    appendRowData('Archive', archResult.headers, updated);
    deleteRowData(tabName, rowIndex);
    // Archive parent project too if all its tasks are now done
    if (updated['Type'] === 'TASK' && updated['Parent_ID']) {
      maybeArchiveProject(tabName, updated['Parent_ID']);
    }
    return { success: true, archived: true };
  }

  updateRowData(tabName, rowIndex, headers, updated);

  // Calendar sync if relevant fields changed
  var calFields = ['Execution_Date', 'Execution_Time', 'Estimated_Duration', 'Status', 'Name'];
  var needsSync = calFields.some(function(f) { return updates[f] !== undefined; });
  if (needsSync && tabName !== 'Inbox' && tabName !== 'Michel_Review') {
    updated = syncCalendar(updated, tabName, rowIndex, headers);
  }

  return { success: true, data: updated };
}

function deleteRowAction(tabName, id) {
  var found = findRowById(tabName, id);
  if (!found) return { error: 'Row not found' };

  var rowIndex = found.rowIndex;
  var data = found.data;

  if (data['Calendar_Event_ID']) {
    try {
      var event = CalendarApp.getDefaultCalendar().getEventById(data['Calendar_Event_ID']);
      if (event) event.deleteEvent();
    } catch (_) {}
  }

  deleteRowData(tabName, rowIndex);
  return { success: true };
}

function addInbox(name, notes) {
  var nextId = getNextId('Inbox');
  var result = getData('Inbox');
  var headers = result.headers;
  var rowData = {
    'ID':           String(nextId),
    'Name':         name  || '',
    'Notes':        notes || '',
    'Created_Date': today(),
  };
  appendRowData('Inbox', headers, rowData);
  return { success: true, id: nextId };
}

// ─── Project auto-archive ─────────────────────────────────────────────────────
// Called after a task is archived. Re-reads the tab; if the parent project has
// no tasks remaining (all were archived to Done), archive the project too.
function maybeArchiveProject(tabName, projectId) {
  var tabData = getData(tabName);

  // Any tasks still in this tab for this project?
  var remaining = tabData.rows.filter(function(r) {
    return r.data['Type'] === 'TASK' && String(r.data['Parent_ID']) === String(projectId);
  });
  if (remaining.length > 0) return false;

  // Find the project row
  var projRow = null;
  for (var i = 0; i < tabData.rows.length; i++) {
    if (String(tabData.rows[i].data['ID']) === String(projectId)) {
      projRow = tabData.rows[i];
      break;
    }
  }
  if (!projRow) return false;

  var projData = {};
  Object.keys(projRow.data).forEach(function(k) { projData[k] = projRow.data[k]; });
  projData['Status']         = 'Done';
  projData['Completed_Date'] = today();
  projData['Last_Modified']  = today();

  var archResult = getData('Archive');
  appendRowData('Archive', archResult.headers, projData);
  deleteRowData(tabName, projRow.rowIndex);
  return true;
}

// ─── Sort order ───────────────────────────────────────────────────────────────
// Accepts orders = [{id, sortOrder}, ...] and writes Sort_Order column values.
// Adds the column to the sheet if it doesn't exist yet.
function updateSortOrder(tabName, orders) {
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) return { error: 'Tab not found: ' + tabName };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || !orders || orders.length === 0) return { success: true };

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);

  // Find or create Sort_Order column
  var sortColIdx = headers.indexOf('Sort_Order');
  var sortColNum;
  if (sortColIdx === -1) {
    sortColNum = lastCol + 1;
    sheet.getRange(1, sortColNum).setValue('Sort_Order');
  } else {
    sortColNum = sortColIdx + 1;
  }

  // Find ID column
  var idIdx = headers.indexOf('ID');
  if (idIdx === -1) idIdx = headers.indexOf('Review_ID');
  if (idIdx === -1) return { error: 'No ID column' };
  var idColNum = idIdx + 1;

  var numDataRows = lastRow - 1;
  var ids = sheet.getRange(2, idColNum, numDataRows, 1).getValues();

  // Read existing Sort_Order values (or empty) so unaffected rows are preserved
  var sortVals;
  if (sortColIdx === -1) {
    sortVals = ids.map(function() { return ['']; });
  } else {
    sortVals = sheet.getRange(2, sortColNum, numDataRows, 1).getValues();
  }

  var orderMap = {};
  orders.forEach(function(o) { orderMap[String(o.id)] = o.sortOrder; });

  ids.forEach(function(row, i) {
    var id = String(row[0]);
    if (orderMap[id] !== undefined) sortVals[i][0] = orderMap[id];
  });

  sheet.getRange(2, sortColNum, numDataRows, 1).setValues(sortVals);
  return { success: true };
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────
function parseDuration(str) {
  if (!str) return null;
  str = String(str).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  var mins = 0;
  var h = str.match(/(\d+(?:\.\d+)?)\s*h/i);
  var m = str.match(/(\d+)\s*m/i);
  if (h) mins += parseFloat(h[1]) * 60;
  if (m) mins += parseInt(m[1], 10);
  return mins || null;
}

// DD-MM-YYYY → YYYY-MM-DD
function toIsoDate(dateStr) {
  if (!dateStr) return dateStr;
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    var p = dateStr.split('-');
    return p[2] + '-' + p[1] + '-' + p[0];
  }
  return dateStr;
}

function syncCalendar(rowData, tabName, rowIndex, headers) {
  var calendar = CalendarApp.getDefaultCalendar();
  var execDate = toIsoDate((rowData['Execution_Date'] || '').trim());
  var calId    = (rowData['Calendar_Event_ID'] || '').trim();

  // Remove event if Execution_Date is cleared
  if (!execDate) {
    if (calId) {
      try {
        var ev = calendar.getEventById(calId);
        if (ev) ev.deleteEvent();
      } catch (_) {}
      var cleared = {};
      Object.keys(rowData).forEach(function(k) { cleared[k] = rowData[k]; });
      cleared['Calendar_Event_ID'] = '';
      updateRowData(tabName, rowIndex, headers, cleared);
      return cleared;
    }
    return rowData;
  }

  var execTime     = (rowData['Execution_Time'] || '').trim();
  var duration     = rowData['Estimated_Duration'];
  var title        = rowData['Name'] || '(no title)';
  var description  = rowData['Notes'] || '';
  var newCalId     = calId;

  if (execTime) {
    // Timed event
    var timeStr   = execTime.length === 5 ? execTime + ':00' : execTime;
    var startDate = new Date(execDate + 'T' + timeStr);
    var durationMins = parseDuration(duration) || 60;
    var endDate   = new Date(startDate.getTime() + durationMins * 60000);

    if (calId) {
      try {
        var existing = calendar.getEventById(calId);
        if (!existing) throw new Error('not found');
        existing.setTitle(title);
        existing.setDescription(description);
        existing.setTime(startDate, endDate);
      } catch (_) {
        var newEv = calendar.createEvent(title, startDate, endDate, { description: description });
        newCalId = newEv.getId();
      }
    } else {
      var newEv2 = calendar.createEvent(title, startDate, endDate, { description: description });
      newCalId = newEv2.getId();
    }
  } else {
    // All-day event
    var parts = execDate.split('-').map(Number);
    var allDayStart = new Date(parts[0], parts[1] - 1, parts[2]);

    if (calId) {
      try {
        var existingAD = calendar.getEventById(calId);
        if (!existingAD) throw new Error('not found');
        existingAD.setTitle(title);
        existingAD.setDescription(description);
      } catch (_) {
        var newAD = calendar.createAllDayEvent(title, allDayStart, { description: description });
        newCalId = newAD.getId();
      }
    } else {
      var newAD2 = calendar.createAllDayEvent(title, allDayStart, { description: description });
      newCalId = newAD2.getId();
    }
  }

  if (newCalId !== calId) {
    var updatedWithCal = {};
    Object.keys(rowData).forEach(function(k) { updatedWithCal[k] = rowData[k]; });
    updatedWithCal['Calendar_Event_ID'] = newCalId;
    updateRowData(tabName, rowIndex, headers, updatedWithCal);
    return updatedWithCal;
  }
  return rowData;
}
