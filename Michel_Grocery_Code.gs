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

// Returns the Monday of the week containing the given date as yyyy-MM-dd.
function weekStartForDate(date) {
  var d = new Date(date);
  d.setHours(0, 0, 0, 0);
  var dow    = d.getDay();
  var offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Returns the Monday of the current week as yyyy-MM-dd.
function currentWeekStart() {
  return weekStartForDate(new Date());
}

// ─── doGet ────────────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';

    switch (action) {
      case 'getMeals':         return jsonOut(getMeals());
      case 'getMealIngredients': return jsonOut(getMealIngredients(e.parameter.meal_id));
      case 'getMealPlan':      return jsonOut(getMealPlanData(e.parameter.week_start));
      case 'getMealHistory':   return jsonOut(getMealHistoryData(e.parameter.meal_id));
      case 'getShoppingList':  return jsonOut(getShoppingListData(e.parameter.week_start));
      case 'getRecentMeals':   return jsonOut(getRecentMealsData(parseInt(e.parameter.weeks || '4', 10)));
      case 'getItemFrequency': return jsonOut(getItemFrequencyData(e.parameter.item));
      default:                 return defaultGet(e);
    }
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// defaultGet — returns {meals, meal_plan, shopping_list} for a week.
function defaultGet(e) {
  var ss           = getSpreadsheet();
  var mealsSheet   = ss.getSheetByName('Meals');
  var planSheet    = ss.getSheetByName('Meal_Plan');
  var listSheet    = ss.getSheetByName('Grocery_List');

  if (!mealsSheet) return jsonOut({ error: 'Meals tab not found' });
  if (!planSheet)  return jsonOut({ error: 'Meal_Plan tab not found' });
  if (!listSheet)  return jsonOut({ error: 'Grocery_List tab not found' });

  var weekStart = (e && e.parameter && e.parameter.week_start)
    ? e.parameter.week_start.trim()
    : currentWeekStart();

  var allMeals    = sheetToObjects(mealsSheet);
  var allPlan     = sheetToObjects(planSheet);
  var allList     = sheetToObjects(listSheet);
  var ingSheet    = ss.getSheetByName('Meal_Ingredients');
  var allIng      = ingSheet ? sheetToObjects(ingSheet) : [];
  var histSheet   = ss.getSheetByName('Meal_History');
  var allHist     = histSheet ? sheetToObjects(histSheet) : [];

  var meals = allMeals
    .filter(function(m) { return m['Archived'] !== 'TRUE'; })
    .map(function(m) {
      var id = m['ID'];
      delete m['_rowIndex'];
      m['ingredients'] = allIng
        .filter(function(r) { return r['Meal_ID'] === id; })
        .map(function(r) { delete r['_rowIndex']; return r; });
      return m;
    });

  var meal_plan = allPlan.filter(function(r) { return r['Week_Start'] === weekStart; });
  var shopping_list = allList.filter(function(r) { return r['Week_Start'] === weekStart; });

  meal_plan.forEach(function(r)     { delete r['_rowIndex']; });
  shopping_list.forEach(function(r) { delete r['_rowIndex']; });

  var meal_history = allHist.filter(function(r) { return r['Week_Start'] === weekStart; });
  meal_history.forEach(function(r) { delete r['_rowIndex']; });

  return jsonOut({ meals: meals, meal_plan: meal_plan, shopping_list: shopping_list, meal_history: meal_history });
}

// ─── doPost ───────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;
    var result;

    switch (action) {
      case 'addMeal':               result = addMeal(body);               break;
      case 'updateMeal':            result = updateMeal(body);            break;
      case 'setMealIngredients':    result = setMealIngredients(body);    break;
      case 'setMenuItem':           result = setMenuItem(body);           break;
      case 'addMealPlan':           result = addMealPlan(body);           break;
      case 'updateMealPlanStatus':  result = updateMealPlanStatus(body);  break;
      case 'addMealHistory':        result = addMealHistory(body);        break;
      case 'savePushToken':         result = savePushToken(body);         break;
      case 'moveMealToHistory':     result = moveMealToHistory(body);     break;
      case 'removeMenuItem':        result = removeMenuItem(body);        break;
      case 'updateShoppingItem':    result = updateShoppingItem(body);    break;
      case 'addShoppingItem':        result = addShoppingItem(body);        break;
      case 'addShoppingItems':       result = addShoppingItems(body);       break;
      case 'resolveMeals':           result = resolveMeals(body);           break;
      case 'generateShoppingList':  result = generateShoppingList(body);  break;
      case 'removeShoppingItem':    result = removeShoppingItem(body);    break;
      case 'addInbox':              result = addInbox(body);              break;
      case 'chat':                  result = handleChat(body);            break;
      default:                      result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── Read actions ─────────────────────────────────────────────────────────────

function getMeals() {
  var ss         = getSpreadsheet();
  var mealsSheet = ss.getSheetByName('Meals');
  var ingSheet   = ss.getSheetByName('Meal_Ingredients');
  if (!mealsSheet) return { error: 'Meals tab not found' };

  var meals  = sheetToObjects(mealsSheet);
  var allIng = ingSheet ? sheetToObjects(ingSheet) : [];

  return meals
    .filter(function(m) { return m['Archived'] !== 'TRUE'; })
    .map(function(m) {
      var id = m['ID'];
      delete m['_rowIndex'];
      m['ingredients'] = allIng
        .filter(function(r) { return r['Meal_ID'] === id; })
        .map(function(r) { delete r['_rowIndex']; return r; });
      return m;
    });
}

function getMealIngredients(meal_id) {
  var ss       = getSpreadsheet();
  var ingSheet = ss.getSheetByName('Meal_Ingredients');
  if (!ingSheet) return { error: 'Meal_Ingredients tab not found' };

  var id  = String(meal_id || '').trim();
  var ing = sheetToObjects(ingSheet)
    .filter(function(r) { return r['Meal_ID'] === id; })
    .map(function(r)    { delete r['_rowIndex']; return r; });

  return { meal_id: id, ingredients: ing };
}

function getMealPlanData(week_start) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Plan');
  if (!sheet) return { error: 'Meal_Plan tab not found' };

  var ws   = String(week_start || currentWeekStart()).trim();
  var rows = sheetToObjects(sheet)
    .filter(function(r) { return r['Week_Start'] === ws; })
    .map(function(r)    { delete r['_rowIndex']; return r; });

  return { week_start: ws, meal_plan: rows };
}

function getShoppingListData(week_start) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var ws   = String(week_start || currentWeekStart()).trim();
  var rows = sheetToObjects(sheet)
    .filter(function(r) { return r['Week_Start'] === ws; })
    .map(function(r)    { delete r['_rowIndex']; return r; });

  return { week_start: ws, items: rows };
}

// getMealHistoryData — returns every time a meal appeared in Meal_History.
function getMealHistoryData(meal_id) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_History');
  if (!sheet) return { error: 'Meal_History tab not found' };

  var id      = String(meal_id || '').trim();
  var history = sheetToObjects(sheet)
    .filter(function(r) { return r['Meal_ID'] === id; })
    .map(function(r) {
      return {
        week_start: r['Week_Start'],
        day:        r['Day'],
        audience:   r['Audience'],
        meal_type:  r['Meal_Type']
      };
    });

  history.sort(function(a, b) { return b.week_start.localeCompare(a.week_start); });
  return { meal_id: id, history: history };
}

// getRecentMealsData — returns meals from Meal_History in the last N weeks.
function getRecentMealsData(weeks) {
  var ss         = getSpreadsheet();
  var histSheet  = ss.getSheetByName('Meal_History');
  if (!histSheet) return { error: 'Meal_History tab not found' };

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var cutoff = new Date(today);
  cutoff.setDate(today.getDate() - (weeks * 7));
  var cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var recent = sheetToObjects(histSheet)
    .filter(function(r) { return r['Week_Start'] >= cutoffStr; })
    .map(function(r) {
      return {
        week_start: r['Week_Start'],
        day:        r['Day'],
        audience:   r['Audience'],
        meal_type:  r['Meal_Type'],
        meal_id:    r['Meal_ID'],
        meal_name:  r['Meal_Name'] || ''
      };
    });

  recent.sort(function(a, b) { return b.week_start.localeCompare(a.week_start); });
  return { weeks: weeks, meals: recent };
}

function getItemFrequencyData(item) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var needle  = String(item || '').toLowerCase().trim();
  var matches = sheetToObjects(sheet).filter(function(r) {
    return r['Item'].toLowerCase().trim() === needle;
  });

  var weeks = matches
    .map(function(r) { return r['Week_Start']; })
    .filter(function(w, i, a) { return a.indexOf(w) === i; })
    .sort()
    .reverse();

  return { item: item, count: matches.length, weeks: weeks };
}

// ─── Write actions ────────────────────────────────────────────────────────────

function addMeal(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meals');
  if (!sheet) return { error: 'Meals tab not found' };

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':       return String(newId);
      case 'Archived': return 'FALSE';
      default:         return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  sheet.appendRow(row);
  return { success: true, id: newId };
}

function updateMeal(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meals');
  if (!sheet) return { error: 'Meals tab not found' };

  var id = String(body.id || '').trim();
  if (!id) return { error: 'Missing required field: id' };

  var headers  = getHeaders(sheet);
  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) { if (r['ID'] === id) existing = r; });
  if (!existing) return { error: 'Meal not found: ' + id };

  var updated = headers.map(function(h) {
    if (h === 'ID') return existing['ID'];
    return body[h] !== undefined ? String(body[h]) : (existing[h] || '');
  });
  sheet.getRange(existing['_rowIndex'], 1, 1, headers.length).setValues([updated]);
  return { success: true };
}

function setMealIngredients(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Ingredients');
  if (!sheet) return { error: 'Meal_Ingredients tab not found' };

  var mealId = String(body.meal_id || '').trim();
  if (!mealId) return { error: 'Missing required field: meal_id' };

  var ingredients = body.ingredients || [];

  var allRows  = sheetToObjects(sheet);
  var toDelete = allRows.filter(function(r) { return r['Meal_ID'] === mealId; });
  toDelete.reverse();
  toDelete.forEach(function(r) { sheet.deleteRow(r['_rowIndex']); });

  if (!ingredients.length) return { success: true, count: 0 };

  var headers = getHeaders(sheet);
  var nextId  = getNextId(sheet);

  ingredients.forEach(function(ing, i) {
    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':       return String(nextId + i);
        case 'Meal_ID':  return mealId;
        case 'Item':     return String(ing['Item']     || ing['item']     || '');
        case 'Quantity': return String(ing['Quantity'] || ing['quantity'] || '');
        case 'Unit':     return String(ing['Unit']     || ing['unit']     || '');
        case 'Category': return String(ing['Category'] || ing['category'] || '');
        default:         return '';
      }
    });
    sheet.appendRow(row);
  });

  return { success: true, count: ingredients.length };
}

// setMenuItem — upserts a single row in Meal_Plan by week_start + day + Audience + Meal_Type.
function setMenuItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Plan');
  if (!sheet) return { error: 'Meal_Plan tab not found' };

  var weekStart = String(body.week_start || '').trim();
  var day       = String(body.day        || '').trim();
  var audience  = String(body.Audience   || '').trim();
  var mealType  = String(body.Meal_Type  || '').trim();
  var mealName  = String(body.Meal_Name  || '').trim();

  if (!weekStart || !day) return { error: 'Missing required fields: week_start, day' };

  // Resolve Meal_ID from Meals sheet; auto-create meal if not found
  if (mealName) {
    var mealsSheet = ss.getSheetByName('Meals');
    if (mealsSheet) {
      var allMeals  = sheetToObjects(mealsSheet);
      var mealEntry = null;
      allMeals.forEach(function(r) {
        if (r['Name'].toLowerCase() === mealName.toLowerCase()) mealEntry = r;
      });
      if (mealEntry) {
        body['Meal_ID'] = mealEntry['ID'];
      } else {
        var newMealId   = getNextId(mealsSheet);
        var mealHeaders = getHeaders(mealsSheet);
        var mealRow     = mealHeaders.map(function(h) {
          if (h === 'ID')       return String(newMealId);
          if (h === 'Name')     return mealName;
          if (h === 'Archived') return 'FALSE';
          return '';
        });
        mealsSheet.appendRow(mealRow);
        body['Meal_ID'] = String(newMealId);
      }
    }
  }

  var headers = getHeaders(sheet);
  var allRows = sheetToObjects(sheet);

  var existing = null;
  allRows.forEach(function(r) {
    if (r['Week_Start'] === weekStart
     && r['Day'].toLowerCase() === day.toLowerCase()
     && r['Audience'] === audience
     && r['Meal_Type'] === mealType) {
      existing = r;
    }
  });

  if (existing) {
    var updated = headers.map(function(h) {
      if (h === 'ID')         return existing['ID'];
      if (h === 'Week_Start') return weekStart;
      if (h === 'Day')        return day;
      if (h === 'Status')     return existing['Status'] || 'planned';
      return body[h] !== undefined ? String(body[h]) : (existing[h] || '');
    });
    sheet.getRange(existing['_rowIndex'], 1, 1, headers.length).setValues([updated]);
    return { success: true, updated: true, id: existing['ID'] };
  }

  var newId = getNextId(sheet);
  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':         return String(newId);
      case 'Week_Start': return weekStart;
      case 'Day':        return day;
      case 'Status':     return 'planned';
      default:           return body[h] !== undefined ? String(body[h]) : '';
    }
  });
  sheet.appendRow(row);
  return { success: true, created: true, id: newId };
}

// addMealPlan — bulk-inserts multiple rows into Meal_Plan.
// body.meals: [{Week_Start, Day, Meal_ID, Meal_Name, Audience, Meal_Type, Status}]
function addMealPlan(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Plan');
  if (!sheet) return { error: 'Meal_Plan tab not found' };

  var meals = body.meals || [];
  if (!meals.length) return { error: 'No meals provided' };

  var headers = getHeaders(sheet);
  var nextId  = getNextId(sheet);
  var ids     = [];

  meals.forEach(function(meal, i) {
    var id = nextId + i;
    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':     return String(id);
        case 'Status': return meal['Status'] || 'planned';
        default:       return meal[h] !== undefined ? String(meal[h]) : '';
      }
    });
    sheet.appendRow(row);
    ids.push(id);
  });

  return { success: true, ids: ids };
}

// updateMealPlanStatus — updates the Status field on a Meal_Plan row by ID.
function updateMealPlanStatus(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Plan');
  if (!sheet) return { error: 'Meal_Plan tab not found' };

  var id     = String(body.id     || '').trim();
  var status = String(body.status || '').trim();
  if (!id)     return { error: 'Missing required field: id' };
  if (!status) return { error: 'Missing required field: status' };

  var headers    = getHeaders(sheet);
  var statusCol  = headers.indexOf('Status') + 1;
  if (statusCol === 0) return { error: 'Status column not found in Meal_Plan' };

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) { if (r['ID'] === id) existing = r; });
  if (!existing) return { error: 'Meal_Plan row not found: ' + id };

  sheet.getRange(existing['_rowIndex'], statusCol).setValue(status);
  return { success: true, id: id, status: status };
}

// moveMealToHistory — copies a Meal_Plan row to Meal_History and sets its status to confirmed.
function moveMealToHistory(body) {
  var ss        = getSpreadsheet();
  var planSheet = ss.getSheetByName('Meal_Plan');
  var histSheet = ss.getSheetByName('Meal_History');
  if (!planSheet) return { error: 'Meal_Plan tab not found' };
  if (!histSheet) return { error: 'Meal_History tab not found' };

  var id = String(body.meal_plan_id || '').trim();
  if (!id) return { error: 'Missing required field: meal_plan_id' };

  var planRows = sheetToObjects(planSheet);
  var existing = null;
  planRows.forEach(function(r) { if (r['ID'] === id) existing = r; });
  if (!existing) return { error: 'Meal_Plan row not found: ' + id };

  // Append to Meal_History
  var histHeaders = getHeaders(histSheet);
  var histId      = getNextId(histSheet);
  var histRow     = histHeaders.map(function(h) {
    switch (h) {
      case 'ID':        return String(histId);
      case 'Week_Start': return existing['Week_Start'];
      case 'Day':       return existing['Day'];
      case 'Meal_ID':   return existing['Meal_ID'];
      case 'Meal_Name': return existing['Meal_Name'];
      case 'Audience':  return existing['Audience'];
      case 'Meal_Type': return existing['Meal_Type'];
      default:          return '';
    }
  });
  histSheet.appendRow(histRow);

  // Mark Meal_Plan row as confirmed
  var planHeaders = getHeaders(planSheet);
  var statusCol   = planHeaders.indexOf('Status') + 1;
  if (statusCol > 0) {
    planSheet.getRange(existing['_rowIndex'], statusCol).setValue('confirmed');
  }

  return { success: true, history_id: histId };
}

// removeMenuItem — deletes a Meal_Plan row by ID.
function removeMenuItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_Plan');
  if (!sheet) return { error: 'Meal_Plan tab not found' };

  var id = String(body.id || '').trim();
  if (!id) return { error: 'Missing required field: id' };

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) { if (r['ID'] === id) existing = r; });
  if (!existing) return { error: 'Meal_Plan row not found: ' + id };

  sheet.deleteRow(existing['_rowIndex']);
  return { success: true };
}

function updateShoppingItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var item      = String(body.item       || '').trim();
  var weekStart = String(body.week_start || '').trim();
  if (!item || !weekStart) return { error: 'Missing required fields: item, week_start' };

  var headers    = getHeaders(sheet);
  var checkedCol = headers.indexOf('Checked') + 1;
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

function addShoppingItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var item      = String(body.item       || '').trim();
  var weekStart = String(body.week_start || '').trim();
  if (!item || !weekStart) return { error: 'Missing required fields: item, week_start' };

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':         return String(newId);
      case 'Item':       return item;
      case 'Week_Start': return weekStart;
      case 'Checked':    return body.checked ? 'TRUE' : 'FALSE';
      case 'Source':     return body.source !== undefined ? String(body.source) : 'manual';
      default:           return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  sheet.appendRow(row);
  return { success: true, id: newId };
}

function generateShoppingList(body) {
  var ss        = getSpreadsheet();
  var planSheet = ss.getSheetByName('Meal_Plan');
  var listSheet = ss.getSheetByName('Grocery_List');
  var ingSheet  = ss.getSheetByName('Meal_Ingredients');

  if (!planSheet) return { error: 'Meal_Plan tab not found' };
  if (!listSheet) return { error: 'Grocery_List tab not found' };

  var weekStart = String(body.week_start || currentWeekStart()).trim();
  var days      = parseInt(body.days || '7', 10);
  if (isNaN(days) || days < 1) days = 7;

  var DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  var wsParts   = weekStart.split('-');
  var wsDate    = new Date(parseInt(wsParts[0],10), parseInt(wsParts[1],10)-1, parseInt(wsParts[2],10));
  wsDate.setHours(0,0,0,0);

  var today = new Date();
  today.setHours(0,0,0,0);
  var cutoff = new Date(today.getTime() + days * 86400000);

  var includedDays = {};
  DAY_NAMES.forEach(function(name, offset) {
    var d = new Date(wsDate);
    d.setDate(wsDate.getDate() + offset);
    if (d >= today && d < cutoff) includedDays[name] = true;
  });

  var allPlan  = sheetToObjects(planSheet);
  var weekPlan = allPlan.filter(function(r) {
    return r['Week_Start'] === weekStart && includedDays[r['Day']];
  });

  var allIng = ingSheet ? sheetToObjects(ingSheet) : [];

  var merged = {};
  weekPlan.forEach(function(planRow) {
    var mealId = planRow['Meal_ID'];
    if (!mealId) return;
    var ings = allIng.filter(function(r) { return r['Meal_ID'] === mealId; });
    ings.forEach(function(ing) {
      var key = ing['Item'].toLowerCase().trim() + '|' + ing['Unit'].toLowerCase().trim();
      if (!merged[key]) {
        merged[key] = { Item: ing['Item'], quantity: 0, Unit: ing['Unit'], Category: ing['Category'], sources: [] };
      }
      merged[key].quantity += parseFloat(ing['Quantity']) || 0;
      if (merged[key].sources.indexOf(planRow['ID']) === -1) {
        merged[key].sources.push(planRow['ID']);
      }
    });
  });

  var allList  = sheetToObjects(listSheet);
  var toDelete = allList.filter(function(r) {
    return r['Week_Start'] === weekStart && r['Source'] !== 'manual';
  });
  toDelete.reverse();
  toDelete.forEach(function(r) { listSheet.deleteRow(r['_rowIndex']); });

  var listHeaders = getHeaders(listSheet);
  var nextId      = getNextId(listSheet);
  var keys        = Object.keys(merged);

  keys.forEach(function(key, i) {
    var item = merged[key];
    var row  = listHeaders.map(function(h) {
      switch (h) {
        case 'ID':         return String(nextId + i);
        case 'Week_Start': return weekStart;
        case 'Item':       return item.Item;
        case 'Quantity':   return item.quantity > 0 ? String(item.quantity) : '';
        case 'Unit':       return item.Unit;
        case 'Category':   return item.Category;
        case 'Source':     return item.sources.join(',');
        case 'Checked':    return 'FALSE';
        default:           return '';
      }
    });
    listSheet.appendRow(row);
  });

  return { success: true, week_start: weekStart, days: days, items_count: keys.length };
}

function addShoppingItems(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var items     = body.items || [];
  var weekStart = String(body.week_start || currentWeekStart()).trim();
  if (!items.length) return { error: 'No items provided' };

  var headers = getHeaders(sheet);
  var nextId  = getNextId(sheet);

  items.forEach(function(item, i) {
    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':         return String(nextId + i);
        case 'Item':       return String(item['Item']     || item['item']     || '');
        case 'Week_Start': return weekStart;
        case 'Quantity':   return String(item['Quantity'] || item['quantity'] || '');
        case 'Unit':       return String(item['Unit']     || item['unit']     || '');
        case 'Category':   return String(item['Category'] || item['category'] || '');
        case 'Source':     return String(item['Source']   || item['source']   || 'chat');
        case 'Checked':    return 'FALSE';
        default:           return '';
      }
    });
    sheet.appendRow(row);
  });

  return { success: true, count: items.length };
}

function removeShoppingItem(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Grocery_List');
  if (!sheet) return { error: 'Grocery_List tab not found' };

  var id = String(body.id || '').trim();
  if (!id) return { error: 'Missing required field: id' };

  var allRows  = sheetToObjects(sheet);
  var existing = null;
  allRows.forEach(function(r) { if (r['ID'] === id) existing = r; });
  if (!existing) return { error: 'Shopping item not found: ' + id };

  sheet.deleteRow(existing['_rowIndex']);
  return { success: true };
}

function resolveMeals(body) {
  var meals = body.meals || [];
  if (!meals.length) return { error: 'No meals provided' };

  var results = [];
  meals.forEach(function(m) {
    var id         = String(m.id         || '').trim();
    var resolution = String(m.resolution || '').trim();
    if (!id || !resolution) { results.push({ id: id, error: 'Missing id or resolution' }); return; }

    if (resolution === 'confirmed') {
      results.push({ id: id, result: moveMealToHistory({ meal_plan_id: id }) });
    } else if (resolution === 'skipped') {
      results.push({ id: id, result: updateMealPlanStatus({ id: id, status: 'skipped' }) });
    } else {
      results.push({ id: id, error: 'Unknown resolution: ' + resolution });
    }
  });

  return { success: true, results: results };
}

function addMealHistory(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Meal_History');
  if (!sheet) return { error: 'Meal_History tab not found' };

  var weekStart = String(body.week_start || '').trim();
  var day       = String(body.day        || '').trim();
  var audience  = String(body.audience   || '').trim();
  var mealType  = String(body.meal_type  || '').trim();
  var mealName  = String(body.meal_name  || '').trim();
  if (!weekStart || !day || !mealName) return { error: 'Missing required fields' };

  var mealId     = '';
  var mealsSheet = ss.getSheetByName('Meals');
  if (mealsSheet) {
    sheetToObjects(mealsSheet).forEach(function(m) {
      if (m['Name'].toLowerCase() === mealName.toLowerCase()) mealId = m['ID'];
    });
  }

  var headers = getHeaders(sheet);
  var newId   = getNextId(sheet);
  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':         return String(newId);
      case 'Week_Start': return weekStart;
      case 'Day':        return day;
      case 'Meal_ID':    return mealId;
      case 'Meal_Name':  return mealName;
      case 'Audience':   return audience;
      case 'Meal_Type':  return mealType;
      default:           return '';
    }
  });
  sheet.appendRow(row);
  return { success: true, id: newId };
}

function savePushToken(body) {
  var token = String(body.token || '').trim();
  if (!token) return { error: 'Missing token' };
  PropertiesService.getScriptProperties().setProperty('FCM_TOKEN', token);
  return { success: true };
}

function getFcmAccessToken_() {
  var saJson = PropertiesService.getScriptProperties().getProperty('FIREBASE_SA_JSON');
  if (!saJson) return null;
  var sa  = JSON.parse(saJson);
  var now = Math.floor(Date.now() / 1000);
  var header = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '');
  var claim  = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  })).replace(/=+$/, '');
  var toSign = header + '.' + claim;
  var sig = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(toSign, sa.private_key)
  ).replace(/=+$/, '');
  var jwt = toSign + '.' + sig;
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText()).access_token || null;
}

function sendPushNotification(title, bodyText) {
  var token = PropertiesService.getScriptProperties().getProperty('FCM_TOKEN');
  if (!token) return;
  var accessToken = getFcmAccessToken_();
  if (!accessToken) return;
  UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/task-manager-e67a5/messages:send', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      message: {
        token: token,
        notification: { title: title, body: bodyText },
        data: { action: 'open_chat' }
      }
    }),
    muteHttpExceptions: true
  });
}

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
      case 'Source':    return body.source   || 'app';
      case 'Processed': return 'FALSE';
      default:          return '';
    }
  });

  sheet.appendRow(row);
  return { success: true };
}

// handleChat — proxies a conversation to the xAI (Grok) API.
function handleChat(body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('XAI_API_KEY');
  if (!apiKey) return { error: 'XAI_API_KEY not configured in Script Properties' };

  var messages = body.messages || [];
  var system   = body.system   || '';

  var xaiMessages = [];
  if (system) xaiMessages.push({ role: 'system', content: system });
  messages.forEach(function(m) {
    xaiMessages.push({ role: m.role, content: m.content });
  });

  var resp = UrlFetchApp.fetch('https://api.x.ai/v1/chat/completions', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'content-type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      max_tokens: 4096,
      messages: xaiMessages
    }),
    muteHttpExceptions: true
  });

  var data = JSON.parse(resp.getContentText());
  if (data.error) return { error: data.error.message };
  if (!data.choices || !data.choices[0]) return { error: 'Empty response from xAI' };
  return { reply: data.choices[0].message.content };
}

// ─── Time trigger ─────────────────────────────────────────────────────────────

// confirmYesterdayMeals — run daily at 9am via a time-based trigger.
// For each Meal_Plan row where Day = yesterday and Status = planned:
//   - If no matching Meal_History entry exists → auto-move to history (status = confirmed)
//   - If a matching entry already exists → set status = unknown
function confirmYesterdayMeals() {
  var ss        = getSpreadsheet();
  var planSheet = ss.getSheetByName('Meal_Plan');
  var histSheet = ss.getSheetByName('Meal_History');
  if (!planSheet || !histSheet) return;

  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  var DAY_NAMES      = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var yesterdayName  = DAY_NAMES[yesterday.getDay()];
  var yesterdayWS    = weekStartForDate(yesterday);

  var planRows     = sheetToObjects(planSheet);
  var histRows     = sheetToObjects(histSheet);
  var unknownCount = 0;

  planRows.forEach(function(row) {
    if (row['Day']        !== yesterdayName) return;
    if (row['Week_Start'] !== yesterdayWS)   return;
    if (row['Status']     !== 'planned')     return;

    var histMatch = histRows.some(function(h) {
      return h['Week_Start'] === row['Week_Start']
          && h['Day']        === row['Day']
          && h['Meal_Type']  === row['Meal_Type']
          && h['Audience']   === row['Audience'];
    });

    if (!histMatch) {
      moveMealToHistory({ meal_plan_id: row['ID'] });
    } else {
      updateMealPlanStatus({ id: row['ID'], status: 'unknown' });
      unknownCount++;
    }
  });

  if (unknownCount > 0) {
    sendPushNotification(
      'Meal check needed',
      unknownCount + ' meal' + (unknownCount > 1 ? 's differ' : ' differs') + ' from plan — open the app to clarify.'
    );
  }

  var yesterdayPlan = planRows.filter(function(r) {
    return r['Week_Start'] === yesterdayWS && r['Day'] === yesterdayName;
  });
  if (yesterdayPlan.length > 0) {
    var histAfter = sheetToObjects(histSheet).filter(function(r) {
      return r['Week_Start'] === yesterdayWS && r['Day'] === yesterdayName;
    });
    var missing = yesterdayPlan.length - histAfter.length;
    if (missing > 0) {
      sendPushNotification(
        'Meals not logged',
        missing + ' meal' + (missing > 1 ? 's' : '') + ' from yesterday still need to be logged.'
      );
    }
  }
}

// setupDailyTrigger — run once from the GAS editor to install the 9am trigger.
function setupDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'confirmYesterdayMeals') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('confirmYesterdayMeals')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
  return 'Daily 9am trigger created for confirmYesterdayMeals';
}
