// ─── Config ───────────────────────────────────────────────────────────────────
var SHEET_ID = '1eucHFP0nIfHH7DSeUKxB1TeBIo23BhEXlSxygZlSUxs';

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
    var hasData = row.some(function(cell) { return cell !== '' && cell !== null; });
    if (!hasData) continue;

    var obj = { _rowIndex: i + 1 };
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
  var rows  = sheetToObjects(sheet);
  var maxId = 0;
  rows.forEach(function(r) {
    var n = parseInt(r['ID'] || '0', 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  return maxId + 1;
}

function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatDateISO(d) {
  var yyyy = d.getFullYear();
  var mm   = String(d.getMonth() + 1).padStart(2, '0');
  var dd   = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

// Returns the Monday of the week containing date d (as yyyy-MM-dd string).
function weekMondayOf(d) {
  var dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  var dow = dt.getDay(); // 0=Sun
  var offset = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + offset);
  return formatDateISO(dt);
}

// ─── Streak / credit calculation ──────────────────────────────────────────────
var DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Builds a map of { 'yyyy-MM-dd': 'TRUE'|'FALSE'|'SKIP' } for one activity.
function buildLogMap(logRows, activityId) {
  var map = {};
  logRows.forEach(function(r) {
    if (r['Activity_ID'] === activityId) {
      // Status column takes priority; fall back to Completed boolean
      var status = String(r['Status'] || '').toUpperCase();
      if (status === 'SKIP') {
        map[r['Date']] = 'SKIP';
      } else if (String(r['Completed']).toUpperCase() === 'TRUE') {
        map[r['Date']] = 'TRUE';
      } else {
        map[r['Date']] = 'FALSE';
      }
    }
  });
  return map;
}

// Returns scheduled day numbers for a Days string.
function scheduledDayNums(daysStr) {
  if (!daysStr || !daysStr.trim()) return [];
  return daysStr.split(',').map(function(d) {
    return DAY_MAP[d.trim()];
  }).filter(function(n) { return n !== undefined; });
}

// ── Weekly habit: streak + credits ────────────────────────────────────────────
// credits = extra completions on non-scheduled days, banked in chronological order.
// A credit can only cover a missed scheduled day that comes AFTER it was earned —
// credits are NOT retroactive.
function calcWeeklyStreakAndCredits(daysStr, logMap) {
  var dayNums = scheduledDayNums(daysStr);
  if (dayNums.length === 0) return { streak: 0, credits: 0 };

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var todayStr = formatDateISO(today);

  // Find the earliest log entry to start the forward walk
  var allDates = Object.keys(logMap).sort();
  if (allDates.length === 0) return { streak: 0, credits: 0 };

  var cursor  = new Date(allDates[0] + 'T00:00:00');
  var credits = 0;
  var streak  = 0;

  while (cursor <= today) {
    var dow     = cursor.getDay();
    var dateStr = formatDateISO(cursor);

    if (dayNums.indexOf(dow) === -1) {
      // Non-scheduled day — bank any extra session
      if (logMap[dateStr] === 'TRUE') credits++;
    } else {
      // Scheduled day
      if (dateStr === todayStr && logMap[dateStr] === undefined) {
        // Today not yet logged — skip without penalty
      } else {
        var entry = logMap[dateStr];
        if (entry === 'TRUE') {
          streak++;
        } else if (entry === 'SKIP') {
          // neutral — don't increment but don't break
        } else {
          // Missed — only credits earned before this day can cover it
          if (credits > 0) {
            credits--;
            streak++;
          } else {
            streak = 0; // streak breaks; credits carry forward
          }
        }
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return { streak: streak, credits: credits };
}

// ── Count habit: streak (in weeks) + credits (banked extra sessions) ──────────
// Walks forward: surplus sessions from week N can only cover a shortfall in week N+1
// or later — not retroactively in a past week.
function calcCountStreakAndCredits(targetPerWeek, logMap) {
  if (!targetPerWeek || targetPerWeek <= 0) return { streak: 0, credits: 0 };

  // Collect all completion dates (TRUE only)
  var doneDates = Object.keys(logMap).filter(function(d) {
    return logMap[d] === 'TRUE';
  }).sort();

  if (doneDates.length === 0) return { streak: 0, credits: 0 };

  // Group completions by week (Monday as key)
  var weekCounts = {};
  doneDates.forEach(function(d) {
    var mon = weekMondayOf(d);
    weekCounts[mon] = (weekCounts[mon] || 0) + 1;
  });

  // Current week's Monday
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var currentMon = weekMondayOf(formatDateISO(today));

  // Walk forward from the earliest week with activity
  var weeks = Object.keys(weekCounts).sort(); // ascending
  var startMon = weeks[0];

  var streak  = 0;
  var balance = 0; // running credit balance (only from past weeks)
  var cursor  = new Date(startMon + 'T00:00:00');

  while (formatDateISO(cursor) <= currentMon) {
    var monStr = formatDateISO(cursor);
    var count  = weekCounts[monStr] || 0;

    // Skip current week if still in progress and has 0 completions
    if (monStr === currentMon && count === 0) break;

    var surplus = count - targetPerWeek;
    if (surplus >= 0) {
      // Met or exceeded target — bank the surplus
      balance += surplus;
      streak++;
    } else {
      // Fell short — only credits earned in prior weeks can cover it
      var deficit = -surplus;
      if (balance >= deficit) {
        balance -= deficit;
        streak++;
      } else {
        streak = 0; // streak breaks; remaining balance carries forward
        balance = Math.max(0, balance - deficit);
      }
    }

    cursor.setDate(cursor.getDate() + 7);
  }

  return { streak: streak, credits: balance };
}

// ── Interval habit: streak ─────────────────────────────────────────────────────
// streak = consecutive on-time completions (within interval + 2 grace days).
// returns { streak, lastCompleted }
function calcIntervalStreakAndLast(intervalDays, logMap) {
  if (!intervalDays || intervalDays <= 0) return { streak: 0, lastCompleted: '' };

  var doneDates = Object.keys(logMap).filter(function(d) {
    return logMap[d] === 'TRUE';
  }).sort().reverse(); // newest first

  if (doneDates.length === 0) return { streak: 0, lastCompleted: '' };

  var grace   = 2;
  var streak  = 1;
  var prev    = new Date(doneDates[0] + 'T00:00:00');

  for (var i = 1; i < doneDates.length; i++) {
    var curr    = new Date(doneDates[i] + 'T00:00:00');
    var diffMs  = prev.getTime() - curr.getTime();
    var diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= intervalDays + grace) {
      streak++;
      prev = curr;
    } else {
      break;
    }
  }

  return { streak: streak, lastCompleted: doneDates[0] };
}

// ─── Week window helpers ──────────────────────────────────────────────────────
function currentWeekBounds() {
  var today      = new Date();
  today.setHours(0, 0, 0, 0);
  var dow        = today.getDay(); // 0=Sun
  var toMonday   = dow === 0 ? -6 : 1 - dow;
  var monday     = new Date(today);
  monday.setDate(today.getDate() + toMonday);
  var sunday     = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { monday: formatDateISO(monday), sunday: formatDateISO(sunday) };
}

// ─── doGet ────────────────────────────────────────────────────────────────────
// Returns: { activities, log, streaks, credits, week_counts, last_completed }
function doGet(e) {
  try {
    var ss          = getSpreadsheet();
    var actSheet    = ss.getSheetByName('Activities');
    var logSheet    = ss.getSheetByName('Log');

    if (!actSheet) return jsonOut({ error: 'Activities tab not found' });
    if (!logSheet) return jsonOut({ error: 'Log tab not found' });

    var actHeaders   = getHeaders(actSheet);
    var statusColNum = actHeaders.indexOf('Status') + 1; // 1-based

    var activities   = sheetToObjects(actSheet);
    var allLog       = sheetToObjects(logSheet);

    // Log for the per-habit consistency grid: 18 weeks back through the end
    // of the current week. Anything shorter and completed sessions are simply
    // absent from the grid.
    var bounds   = currentWeekBounds();
    var histFrom = new Date(); histFrom.setHours(0,0,0,0);
    histFrom.setDate(histFrom.getDate() - 18 * 7);
    var logStart = formatDateISO(histFrom);
    var weekLog = allLog.filter(function(r) {
      return r['Date'] >= logStart && r['Date'] <= bounds.sunday;
    });

    // Compute stats for all activities
    var streaks       = {};
    var credits       = {};
    var week_counts   = {};
    var last_completed = {};

    activities.forEach(function(act) {
      var logMap    = buildLogMap(allLog, act['ID']);
      var freq      = String(act['Frequency'] || 'weekly').toLowerCase();
      var target    = parseInt(act['Target_Per_Week'] || '0', 10);
      var interval  = parseInt(act['Interval_Days']   || '0', 10);

      if (freq === 'count') {
        var res = calcCountStreakAndCredits(target, logMap);
        streaks[act['ID']]  = res.streak;
        credits[act['ID']]  = res.credits;
        // Week count for this week
        var monStr = bounds.monday;
        var wc = 0;
        allLog.forEach(function(r) {
          if (r['Activity_ID'] === act['ID'] &&
              r['Date'] >= monStr && r['Date'] <= bounds.sunday &&
              String(r['Completed']).toUpperCase() === 'TRUE') wc++;
        });
        week_counts[act['ID']] = wc;

      } else if (freq === 'interval') {
        var res = calcIntervalStreakAndLast(interval, logMap);
        streaks[act['ID']]        = res.streak;
        credits[act['ID']]        = 0;
        last_completed[act['ID']] = res.lastCompleted;

      } else {
        // weekly (default)
        var res = calcWeeklyStreakAndCredits(act['Days'], logMap);
        streaks[act['ID']] = res.streak;
        credits[act['ID']] = res.credits;
      }
    });

    // Auto-unlock: check locked activities whose Unlock_Condition is now met
    activities.forEach(function(act) {
      if (act['Status'] !== 'locked' || !act['Unlock_Condition']) return;

      var match = act['Unlock_Condition'].match(/^(\w+)_streak>=(\d+)$/);
      if (!match) return;

      var refId     = match[1];
      var threshold = parseInt(match[2], 10);
      if ((streaks[refId] || 0) >= threshold) {
        if (statusColNum > 0) {
          actSheet.getRange(act['_rowIndex'], statusColNum).setValue('active');
        }
        act['Status'] = 'active';
      }
    });

    // Strip internal _rowIndex before returning
    activities.forEach(function(act) { delete act['_rowIndex']; });
    weekLog.forEach(function(r)      { delete r['_rowIndex']; });

    return jsonOut({
      activities:     activities,
      log:            weekLog,
      streaks:        streaks,
      credits:        credits,
      week_counts:    week_counts,
      last_completed: last_completed
    });
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
      case 'addActivity':    result = addActivity(body);    break;
      case 'updateActivity': result = updateActivity(body); break;
      case 'logActivity':    result = logActivity(body);    break;
      case 'addInbox':       result = addInbox(body);       break;
      default:               result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

// addActivity — appends a new row to Activities.
// Required: Name
// Optional: Category, Days, Status, Frequency, Target_Per_Week, Interval_Days
function addActivity(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Activities');
  if (!sheet) return { error: 'Activities tab not found' };

  var name = (body.Name || '').trim();
  if (!name) return { error: 'Missing required field: Name' };

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':     return String(newId);
      case 'Status': return body.Status || 'active';
      default:       return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  sheet.appendRow(row);
  return { success: true, id: newId };
}

// updateActivity — finds an activity by ID and updates fields.
// Required: id
// Optional: Name, Category, Days, Frequency, Target_Per_Week, Interval_Days
function updateActivity(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Activities');
  if (!sheet) return { error: 'Activities tab not found' };

  var targetId = String(body.id || '').trim();
  if (!targetId) return { error: 'Missing required field: id' };

  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: 'No rows in Activities' };

  var idCol = headers.indexOf('ID') + 1;
  if (idCol === 0) return { error: 'ID column not found' };

  var idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  var rowIndex = -1;
  for (var i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0]) === targetId) { rowIndex = i + 2; break; }
  }
  if (rowIndex === -1) return { error: 'Activity not found: ' + targetId };

  var existing = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var SKIP = { action: true, id: true };
  headers.forEach(function(h, j) {
    if (!SKIP[h] && body[h] !== undefined) existing[j] = String(body[h]);
  });

  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([existing]);
  return { success: true, id: targetId };
}

// logActivity — upserts a row in Log for a given date + activity_id.
// Required: activity_id, date (yyyy-MM-dd), completed (true|false)
// Optional: status ('done'|'skip'), notes
function logActivity(body) {
  var ss       = getSpreadsheet();
  var sheet    = ss.getSheetByName('Log');
  if (!sheet) return { error: 'Log tab not found' };

  var activityId = String(body.activity_id || '').trim();
  var date       = String(body.date        || '').trim();
  var completed  = body.completed;

  if (!activityId || !date) {
    return { error: 'Missing required fields: activity_id, date' };
  }

  var headers      = getHeaders(sheet);
  var completedCol = headers.indexOf('Completed') + 1;

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) {
    if (r['Date'] === date && r['Activity_ID'] === activityId) existing = r;
  });

  if (existing) {
    // Update existing row: Completed + optional Status and Notes
    sheet.getRange(existing['_rowIndex'], completedCol).setValue(completed ? 'TRUE' : 'FALSE');

    var statusCol = headers.indexOf('Status') + 1;
    if (statusCol > 0 && body.status !== undefined) {
      sheet.getRange(existing['_rowIndex'], statusCol).setValue(String(body.status));
    }
    var notesCol = headers.indexOf('Notes') + 1;
    if (notesCol > 0 && body.notes !== undefined) {
      sheet.getRange(existing['_rowIndex'], notesCol).setValue(String(body.notes));
    }
    return { success: true, updated: true };
  }

  // Append new row
  var row = headers.map(function(h) {
    switch (h) {
      case 'Date':        return date;
      case 'Activity_ID': return activityId;
      case 'Completed':   return completed ? 'TRUE' : 'FALSE';
      case 'Status':      return body.status !== undefined ? String(body.status) : (completed ? 'done' : '');
      case 'Notes':       return body.notes  !== undefined ? String(body.notes)  : '';
      default:            return '';
    }
  });
  sheet.appendRow(row);
  return { success: true, created: true };
}

// addInbox — appends a message to the Inbox tab.
// Required: message
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

// ─── One-time setup ───────────────────────────────────────────────────────────
// Run this once from the Apps Script editor to add the new columns to Activities.
function addNewActivityColumns() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Activities');
  if (!sheet) { Logger.log('Activities tab not found'); return; }

  var headers = getHeaders(sheet);
  var toAdd   = ['Frequency', 'Target_Per_Week', 'Interval_Days'];

  toAdd.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(col).setFontWeight('bold');
      Logger.log('Added column: ' + col);
    } else {
      Logger.log('Already exists: ' + col);
    }
  });
}
