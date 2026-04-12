// ─── Config ───────────────────────────────────────────────────────────────────
var SHEET_ID = '19ZKWN0vZG6Xzy7cnHZVd5Kyuad2fQitXW4jaNmmq5n8';

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

function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

// Returns the Monday of the current week as yyyy-MM-dd.
function currentWeekStart() {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var dow     = today.getDay(); // 0=Sun
  var offset  = dow === 0 ? -6 : 1 - dow;
  var monday  = new Date(today);
  monday.setDate(today.getDate() + offset);
  return Utilities.formatDate(monday, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ─── doGet ────────────────────────────────────────────────────────────────────
// Query param: week_start (yyyy-MM-dd, optional — defaults to current Monday)
// Returns: { meals, menu, shopping_list }
function doGet(e) {
  try {
    var ss        = getSpreadsheet();
    var mealsSheet = ss.getSheetByName('Meals');
    var menuSheet  = ss.getSheetByName('Menu');
    var listSheet  = ss.getSheetByName('Shopping_List');

    if (!mealsSheet) return jsonOut({ error: 'Meals tab not found' });
    if (!menuSheet)  return jsonOut({ error: 'Menu tab not found' });
    if (!listSheet)  return jsonOut({ error: 'Shopping_List tab not found' });

    var weekStart = (e && e.parameter && e.parameter.week_start)
      ? e.parameter.week_start.trim()
      : currentWeekStart();

    var meals    = sheetToObjects(mealsSheet);
    var allMenu  = sheetToObjects(menuSheet);
    var allList  = sheetToObjects(listSheet);

    var menu = allMenu.filter(function(r) {
      return r['Week_Start'] === weekStart;
    });

    var shopping_list = allList.filter(function(r) {
      return r['Week_Start'] === weekStart;
    });

    // Strip internal _rowIndex before returning
    meals.forEach(function(r)         { delete r['_rowIndex']; });
    menu.forEach(function(r)          { delete r['_rowIndex']; });
    shopping_list.forEach(function(r) { delete r['_rowIndex']; });

    return jsonOut({ meals: meals, menu: menu, shopping_list: shopping_list });
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
      case 'addMeal':               result = addMeal(body);               break;
      case 'setMenuItem':           result = setMenuItem(body);           break;
      case 'updateMenuIngredients': result = updateMenuIngredients(body); break;
      case 'updateShoppingItem':    result = updateShoppingItem(body);    break;
      case 'addShoppingItem':       result = addShoppingItem(body);       break;
      case 'addInbox':              result = addInbox(body);              break;
      default:                      result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

// addMeal — appends a new meal to the Meals tab.
// Required body fields: name
// Optional: tags, prep_time, ingredients
function addMeal(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meals');
  if (!sheet) return { error: 'Meals tab not found' };

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID': return String(newId);
      default:   return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  sheet.appendRow(row);
  return { success: true, id: newId };
}

// setMenuItem — upserts a row in Menu by week_start + day + Person + Meal_Type.
// Also ensures the meal name exists in the Meals sheet (canonical list).
// Required body fields: week_start (yyyy-MM-dd), day (e.g. 'Monday'), Person, Meal_Type, Meal_Name
function setMenuItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Menu');
  if (!sheet) return { error: 'Menu tab not found' };

  var weekStart = String(body.week_start || '').trim();
  var day       = String(body.day        || '').trim();
  var person    = String(body.Person     || '').trim();
  var mealType  = String(body.Meal_Type  || '').trim();
  var mealName  = String(body.Meal_Name  || '').trim();

  if (!weekStart || !day) {
    return { error: 'Missing required fields: week_start, day' };
  }

  // Ensure meal name exists in Meals sheet; resolve Meal_ID
  if (mealName) {
    var mealsSheet = ss.getSheetByName('Meals');
    if (mealsSheet) {
      var allMeals   = sheetToObjects(mealsSheet);
      var mealEntry  = null;
      allMeals.forEach(function(r) {
        if (r['Name'].toLowerCase() === mealName.toLowerCase()) mealEntry = r;
      });
      if (mealEntry) {
        body['Meal_ID'] = mealEntry['ID'];
      } else {
        var newMealId   = getNextId(mealsSheet);
        var mealHeaders = getHeaders(mealsSheet);
        var mealRow     = mealHeaders.map(function(h) {
          if (h === 'ID')   return String(newMealId);
          if (h === 'Name') return mealName;
          return '';
        });
        mealsSheet.appendRow(mealRow);
        body['Meal_ID'] = String(newMealId);
      }
    }
  }

  var headers  = getHeaders(sheet);
  var allRows  = sheetToObjects(sheet);

  // Search for existing row matching week_start + day + Person + Meal_Type
  var existing = null;
  allRows.forEach(function(r) {
    if (r['Week_Start'] === weekStart
     && r['Day'].toLowerCase() === day.toLowerCase()
     && r['Person'] === person
     && r['Meal_Type'] === mealType) {
      existing = r;
    }
  });

  if (existing) {
    // Update in place — rewrite the full row with new values
    var updated = headers.map(function(h) {
      if (h === 'ID')         return existing['ID'];
      if (h === 'Week_Start') return weekStart;
      if (h === 'Day')        return day;
      return body[h] !== undefined ? String(body[h]) : (existing[h] || '');
    });
    sheet.getRange(existing['_rowIndex'], 1, 1, headers.length).setValues([updated]);
    return { success: true, updated: true, id: existing['ID'] };
  }

  // Append new row
  var newId = getNextId(sheet);
  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':         return String(newId);
      case 'Week_Start': return weekStart;
      case 'Day':        return day;
      default:           return body[h] !== undefined ? String(body[h]) : '';
    }
  });
  sheet.appendRow(row);
  return { success: true, created: true, id: newId };
}

// backfillMeals — populates the Meals sheet from unique Meal_Name values already in Menu.
// Run once from the GAS editor after deploying this update.
function backfillMeals() {
  var ss         = getSpreadsheet();
  var menuSheet  = ss.getSheetByName('Menu');
  var mealsSheet = ss.getSheetByName('Meals');
  if (!menuSheet || !mealsSheet) return 'Missing sheets';

  var menuRows   = sheetToObjects(menuSheet);
  var mealRows   = sheetToObjects(mealsSheet);
  var mealHeaders = getHeaders(mealsSheet);

  // Build map of names already in Meals (lowercase → ID)
  var existing = {};
  mealRows.forEach(function(r) {
    if (r['Name']) existing[r['Name'].toLowerCase()] = r['ID'];
  });

  var added = 0;
  menuRows.forEach(function(r) {
    var name = (r['Meal_Name'] || '').trim();
    if (!name || existing[name.toLowerCase()]) return;
    var newId = getNextId(mealsSheet);
    var row   = mealHeaders.map(function(h) {
      if (h === 'ID')   return String(newId);
      if (h === 'Name') return name;
      return '';
    });
    mealsSheet.appendRow(row);
    existing[name.toLowerCase()] = String(newId);
    added++;
  });

  return 'Backfilled ' + added + ' meal(s). Total in Meals: ' + (mealRows.length + added);
}

// updateShoppingItem — finds a Shopping_List row by item + week_start and updates Checked.
// Required body fields: item, week_start
// Optional: checked (boolean, defaults to true)
function updateShoppingItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Shopping_List');
  if (!sheet) return { error: 'Shopping_List tab not found' };

  var item      = String(body.item       || '').trim();
  var weekStart = String(body.week_start || '').trim();

  if (!item || !weekStart) {
    return { error: 'Missing required fields: item, week_start' };
  }

  var headers    = getHeaders(sheet);
  var checkedCol = headers.indexOf('Checked') + 1; // 1-based
  if (checkedCol === 0) return { error: 'Checked column not found' };

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) {
    if (r['Item'].toLowerCase() === item.toLowerCase() && r['Week_Start'] === weekStart) {
      existing = r;
    }
  });

  if (!existing) return { error: 'Shopping item not found: ' + item + ' / ' + weekStart };

  var checked = body.checked !== undefined ? body.checked : true;
  sheet.getRange(existing['_rowIndex'], checkedCol).setValue(checked ? 'TRUE' : 'FALSE');
  return { success: true, id: existing['ID'] };
}

// addShoppingItem — appends a new item to Shopping_List.
// Required body fields: item, week_start
// Optional: quantity, unit, checked (defaults to FALSE)
function addShoppingItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Shopping_List');
  if (!sheet) return { error: 'Shopping_List tab not found' };

  var item      = String(body.item       || '').trim();
  var weekStart = String(body.week_start || '').trim();
  if (!item || !weekStart) {
    return { error: 'Missing required fields: item, week_start' };
  }

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':         return String(newId);
      case 'Item':       return item;
      case 'Week_Start': return weekStart;
      case 'Checked':    return body.checked ? 'TRUE' : 'FALSE';
      default:           return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  sheet.appendRow(row);
  return { success: true, id: newId };
}

// updateMenuIngredients — finds a Menu row by ID and updates its Ingredients field.
// Required body fields: id, ingredients
function updateMenuIngredients(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Menu');
  if (!sheet) return { error: 'Menu tab not found' };

  var id = String(body.id || '').trim();
  if (!id) return { error: 'Missing required field: id' };

  var headers = getHeaders(sheet);
  var ingCol  = headers.indexOf('Ingredients') + 1; // 1-based
  if (ingCol === 0) return { error: 'Ingredients column not found — run setupGrocerySchema first' };

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) { if (r['ID'] === id) existing = r; });

  if (!existing) return { error: 'Menu row not found: ' + id };

  sheet.getRange(existing['_rowIndex'], ingCol).setValue(body.ingredients || '');
  return { success: true, id: id };
}

// setupGrocerySchema — adds missing columns (Person, Meal_Type, Ingredients) to Menu.
// Run once from the GAS editor after deploying this file.
function setupGrocerySchema() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Menu');
  if (!sheet) return 'Menu tab not found';

  var needed  = ['Person', 'Meal_Type', 'Ingredients'];
  var headers = getHeaders(sheet);

  needed.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(col);
      headers.push(col);
    }
  });
  return 'Schema OK: ' + headers.join(', ');
}

// addInbox — appends a message to the Inbox tab.
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
