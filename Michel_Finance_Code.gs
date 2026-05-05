// ─── Config ───────────────────────────────────────────────────────────────────
var SHEET_ID = '1pvQjGIOB2k1wyNjfeNLwoFSeTel8ffx1r51yaETasKo';

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
  var rows  = sheetToObjects(sheet);
  var maxId = 0;
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
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function currentMonthYear() {
  var d = new Date();
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

// Maps Dutch month abbreviations to month numbers.
var DUTCH_MONTHS = {jan:1,feb:2,mrt:3,apr:4,mei:5,jun:6,jul:7,aug:8,sep:9,okt:10,nov:11,dec:12};

function parseMonth(val) {
  var n = parseInt(val, 10);
  if (!isNaN(n)) return n;
  return DUTCH_MONTHS[String(val).toLowerCase().trim()] || 0;
}

// Parses amounts in both Dutch format ("€ 2.560,00") and plain numeric ("2560.00").
function parseAmount(val) {
  var s = String(val).replace(/[€\s]/g, '');
  // Only treat dot as thousands separator when a comma is also present (Dutch locale).
  if (s.indexOf(',') !== -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  return parseFloat(s) || 0;
}

// Returns the effective budget for a category at a given month/year using carry-forward:
// finds the most recent Budget entry where (year, month) <= (reqYear, reqMonth).
function effectiveBudget(allBud, cats, category, reqMonth, reqYear) {
  var bestAmt = null, bestY = -1, bestM = -1;
  allBud.forEach(function(r) {
    if (r['Category'] !== category) return;
    var bm = parseMonth(r['Month']);
    var by = parseInt(r['Year'], 10);
    if (by < reqYear || (by === reqYear && bm <= reqMonth)) {
      if (by > bestY || (by === bestY && bm > bestM)) {
        bestY = by; bestM = bm;
        bestAmt = parseFloat(r['Amount'] || '0');
      }
    }
  });
  if (bestAmt !== null) return bestAmt;
  // Fall back to Categories.Budget column
  var fallback = 0;
  cats.forEach(function(c) {
    if (c['Name'] === category) fallback = parseFloat(c['Budget'] || '0');
  });
  return fallback;
}

// ─── doGet ────────────────────────────────────────────────────────────────────
// Normal mode: ?month=M&year=Y → { transactions, budget, categories }
// History mode: ?mode=history&category=X&month=M&year=Y → { history: [...6 months] }
function doGet(e) {
  try {
    var ss = getSpreadsheet();
    var txSheet     = ss.getSheetByName('Transactions');
    var budgetSheet = ss.getSheetByName('Budget');
    var catSheet    = ss.getSheetByName('Categories');

    if (!txSheet)     return jsonOut({ error: 'Transactions tab not found' });
    if (!budgetSheet) return jsonOut({ error: 'Budget tab not found' });
    if (!catSheet)    return jsonOut({ error: 'Categories tab not found' });

    var ref   = currentMonthYear();
    var month = parseInt((e && e.parameter && e.parameter.month) || ref.month, 10);
    var year  = parseInt((e && e.parameter && e.parameter.year)  || ref.year,  10);

    var allTx  = sheetToObjects(txSheet);
    var allBud = sheetToObjects(budgetSheet);
    var cats   = sheetToObjects(catSheet);

    // Sort categories by Order column (if present)
    cats.sort(function(a, b) {
      var oa = parseInt(a['Order'] || '999', 10);
      var ob = parseInt(b['Order'] || '999', 10);
      return oa - ob;
    });

    // History mode: return 6-month rolling budget vs tracked for one category
    if (e && e.parameter && e.parameter.mode === 'history') {
      var category = (e.parameter.category || '').trim();
      var MONTH_ABBR = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var history = [];
      for (var i = 5; i >= 0; i--) {
        var m = month - i, y = year;
        while (m <= 0) { m += 12; y--; }
        var bud = effectiveBudget(allBud, cats, category, m, y);
        var tracked = 0;
        allTx.forEach(function(r) {
          if (r['Category'] === category && parseMonth(r['Month']) === m && parseInt(r['Year'], 10) === y) {
            tracked += parseAmount(r['Amount']);
          }
        });
        history.push({ month: m, year: y, label: MONTH_ABBR[m], budget: bud, tracked: Math.round(tracked * 100) / 100 });
      }
      return jsonOut({ history: history });
    }

    var transactions = allTx.filter(function(r) {
      return parseMonth(r['Month']) === month && parseInt(r['Year'], 10) === year;
    }).map(function(r) {
      return Object.assign({}, r, { Amount: String(parseAmount(r['Amount'])) });
    });

    // Build effective budget per category for this month (carry-forward)
    var budgetForMonth = cats.map(function(c) {
      var name = c['Name'];
      var amt  = effectiveBudget(allBud, cats, name, month, year);
      return { Category: name, Amount: String(amt) };
    });

    var merchantSheet = ss.getSheetByName('Merchants');
    var merchants = merchantSheet ? sheetToObjects(merchantSheet) : [];

    return jsonOut({ transactions: transactions, budget: budgetForMonth, categories: cats, merchants: merchants });
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
      case 'addTransaction':      result = addTransaction(body);          break;
      case 'batchAddTransactions': result = batchAddTransactions(body);  break;
      case 'updateBudget':       result = updateBudget(body);       break;
      case 'setBudgetAllYear':   result = setBudgetAllYear(body);   break;
      case 'setMonthlyBudgets':  result = setMonthlyBudgets(body);  break;
      case 'updateCategoryOrder':result = updateCategoryOrder(body);break;
      case 'addInbox':           result = addInbox(body);           break;
      case 'saveMerchant':       result = saveMerchant(body);       break;
      case 'chat':               result = handleChat(body);         break;
      default:                   result = { error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.toString() });
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

// addTransaction — appends to Transactions after validating category exists.
function addTransaction(body) {
  var ss      = getSpreadsheet();
  var txSheet = ss.getSheetByName('Transactions');
  var catSheet = ss.getSheetByName('Categories');
  if (!txSheet)  return { error: 'Transactions tab not found' };
  if (!catSheet) return { error: 'Categories tab not found' };

  var category  = (body.category || '').trim();
  var cats      = sheetToObjects(catSheet);
  var catExists = cats.some(function(c) {
    return c['Name'].toLowerCase() === category.toLowerCase();
  });
  if (!catExists) return { error: 'Category not found: ' + category };

  var dateStr = (body.date || '').trim();
  var month   = body.month;
  var year    = body.year;
  if (!month || !year) {
    if (dateStr) {
      var parts = dateStr.split('-');
      year  = parts[0];
      month = parseInt(parts[1], 10);
    } else {
      var ref = currentMonthYear();
      month   = ref.month;
      year    = ref.year;
    }
  }

  var headers = getHeaders(txSheet);
  var newId   = getNextId(txSheet);

  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':    return String(newId);
      case 'Month': return String(month);
      case 'Year':  return String(year);
      default:      return body[h] !== undefined ? String(body[h]) : '';
    }
  });

  txSheet.appendRow(row);
  return { success: true, id: newId };
}

// batchAddTransactions — appends multiple transactions in a single call.
// body.transactions = array of transaction objects (same fields as addTransaction).
// Returns { success, count, errors } where errors lists any rows that failed.
function batchAddTransactions(body) {
  var transactions = body.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { error: 'transactions must be a non-empty array' };
  }
  var errors = [];
  var count  = 0;
  transactions.forEach(function(tx, i) {
    var result = addTransaction(tx);
    if (result.error) {
      errors.push({ index: i, merchant: tx.Merchant || tx.merchant || '', error: result.error });
    } else {
      count++;
    }
  });
  return { success: true, count: count, errors: errors };
}

// updateBudget — creates or updates a Budget entry for category + month + year.
function updateBudget(body) {
  var ss          = getSpreadsheet();
  var budgetSheet = ss.getSheetByName('Budget');
  if (!budgetSheet) return { error: 'Budget tab not found' };

  var category = (body.category || '').trim();
  var month    = String(body.month  || '').trim();
  var year     = String(body.year   || '').trim();
  var amount   = String(body.amount || '').trim();

  if (!category || !month || !year || amount === '') {
    return { error: 'Missing required fields: category, month, year, amount' };
  }

  var headers  = getHeaders(budgetSheet);
  var lastRow  = budgetSheet.getLastRow();

  var foundRow = -1;
  if (lastRow >= 2) {
    var values = budgetSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      var rCat   = String(r[headers.indexOf('Category')] || '').trim().toLowerCase();
      var rMonth = String(r[headers.indexOf('Month')]    || '').trim();
      var rYear  = String(r[headers.indexOf('Year')]     || '').trim();
      if (rCat === category.toLowerCase() && rMonth === month && rYear === year) {
        foundRow = i + 2;
        break;
      }
    }
  }

  if (foundRow !== -1) {
    var amtCol = headers.indexOf('Amount') + 1;
    if (amtCol === 0) return { error: 'Amount column not found in Budget' };
    budgetSheet.getRange(foundRow, amtCol).setValue(amount);
    return { success: true, updated: true };
  }

  var newId = getNextId(budgetSheet);
  var row = headers.map(function(h) {
    switch (h) {
      case 'ID':       return String(newId);
      case 'Category': return category;
      case 'Type':     return body.type || '';
      case 'Month':    return month;
      case 'Year':     return year;
      case 'Amount':   return amount;
      default:         return '';
    }
  });

  budgetSheet.appendRow(row);
  return { success: true, created: true, id: newId };
}

// setBudgetAllYear — deletes all Budget entries for category+year, inserts 12 new rows.
function setBudgetAllYear(body) {
  var ss          = getSpreadsheet();
  var budgetSheet = ss.getSheetByName('Budget');
  if (!budgetSheet) return { error: 'Budget tab not found' };

  var category = (body.category || '').trim();
  var year     = parseInt(body.year, 10);
  var amount   = String(body.amount || '').trim();
  var type     = body.type || '';

  if (!category || !year || amount === '') return { error: 'Missing fields' };

  var headers = getHeaders(budgetSheet);
  var lastRow = budgetSheet.getLastRow();

  // Delete existing rows for this category+year (iterate in reverse to preserve indices)
  if (lastRow >= 2) {
    var values = budgetSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var rCat  = String(values[i][headers.indexOf('Category')] || '').trim().toLowerCase();
      var rYear = String(values[i][headers.indexOf('Year')]     || '').trim();
      if (rCat === category.toLowerCase() && parseInt(rYear, 10) === year) {
        budgetSheet.deleteRow(i + 2);
      }
    }
  }

  // Insert 12 rows (one per month)
  var newId = getNextId(budgetSheet);
  for (var m = 1; m <= 12; m++) {
    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':       return String(newId++);
        case 'Category': return category;
        case 'Type':     return type;
        case 'Month':    return String(m);
        case 'Year':     return String(year);
        case 'Amount':   return amount;
        default:         return '';
      }
    });
    budgetSheet.appendRow(row);
  }

  return { success: true };
}

// setMonthlyBudgets — sets 12 different amounts (one per month) for a category+year.
// body.amounts = array of 12 numbers [jan, feb, ..., dec]
function setMonthlyBudgets(body) {
  var ss          = getSpreadsheet();
  var budgetSheet = ss.getSheetByName('Budget');
  if (!budgetSheet) return { error: 'Budget tab not found' };

  var category = (body.category || '').trim();
  var year     = parseInt(body.year, 10);
  var amounts  = body.amounts;
  var type     = body.type || '';

  if (!category || !year || !Array.isArray(amounts) || amounts.length !== 12) {
    return { error: 'Missing or invalid fields: category, year, amounts (array of 12)' };
  }

  var headers = getHeaders(budgetSheet);
  var lastRow = budgetSheet.getLastRow();

  // Delete existing rows for this category+year
  if (lastRow >= 2) {
    var values = budgetSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var rCat  = String(values[i][headers.indexOf('Category')] || '').trim().toLowerCase();
      var rYear = String(values[i][headers.indexOf('Year')]     || '').trim();
      if (rCat === category.toLowerCase() && parseInt(rYear, 10) === year) {
        budgetSheet.deleteRow(i + 2);
      }
    }
  }

  // Insert 12 rows, one per month, each with its own amount
  var newId = getNextId(budgetSheet);
  for (var m = 1; m <= 12; m++) {
    var amount = String(amounts[m - 1]);
    var row = headers.map(function(h) {
      switch (h) {
        case 'ID':       return String(newId++);
        case 'Category': return category;
        case 'Type':     return type;
        case 'Month':    return String(m);
        case 'Year':     return String(year);
        case 'Amount':   return amount;
        default:         return '';
      }
    });
    budgetSheet.appendRow(row);
  }

  return { success: true };
}

// updateCategoryOrder — writes Order values to the Categories sheet.
// body.names = ordered array of category names (expenses); deposits are not included.
function updateCategoryOrder(body) {
  var ss       = getSpreadsheet();
  var catSheet = ss.getSheetByName('Categories');
  if (!catSheet) return { error: 'Categories tab not found' };

  var names = body.names || [];
  if (!names.length) return { error: 'No names provided' };

  var headers  = getHeaders(catSheet);
  var orderCol = headers.indexOf('Order');
  if (orderCol === -1) return { error: 'Order column not found in Categories' };

  var lastRow = catSheet.getLastRow();
  if (lastRow < 2) return { success: true };

  var nameCol = headers.indexOf('Name');
  var values  = catSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  for (var i = 0; i < values.length; i++) {
    var rowName  = String(values[i][nameCol] || '').trim();
    var orderIdx = names.indexOf(rowName);
    if (orderIdx !== -1) {
      catSheet.getRange(i + 2, orderCol + 1).setValue(orderIdx + 1);
    }
  }

  return { success: true };
}

// addInbox — appends a message to the Inbox tab.
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

// saveMerchant — upserts a row in the Merchants tab by RawName.
function saveMerchant(body) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Merchants');
  if (!sheet) return { error: 'Merchants tab not found. Run setupMerchantsTab() first.' };

  var rawName = (body.rawName || '').trim();
  if (!rawName) return { error: 'rawName is required' };

  var HEADERS = ['RawName', 'Nickname', 'DefaultCategory', 'Ambiguous', 'Recurring', 'Frequency', 'PaymentsLeft'];
  var lastRow = sheet.getLastRow();
  var foundRow = -1;

  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === rawName.toLowerCase()) {
        foundRow = i + 2;
        break;
      }
    }
  }

  var row = HEADERS.map(function(h) {
    switch (h) {
      case 'RawName':         return rawName;
      case 'Nickname':        return String(body.nickname        || '');
      case 'DefaultCategory': return String(body.defaultCategory || '');
      case 'Ambiguous':       return body.ambiguous  ? 'TRUE' : 'FALSE';
      case 'Recurring':       return body.recurring  ? 'TRUE' : 'FALSE';
      case 'Frequency':       return body.frequency  != null ? String(body.frequency)    : '';
      case 'PaymentsLeft':    return body.paymentsLeft != null ? String(body.paymentsLeft) : '';
      default:                return '';
    }
  });

  if (foundRow !== -1) {
    sheet.getRange(foundRow, 1, 1, HEADERS.length).setValues([row]);
    return { success: true, updated: true };
  }
  sheet.appendRow(row);
  return { success: true, created: true };
}

// setupMerchantsTab — one-time setup. Run manually from the GAS editor.
function setupMerchantsTab() {
  var ss = getSpreadsheet();
  if (ss.getSheetByName('Merchants')) {
    Logger.log('Merchants tab already exists.');
    return;
  }
  var sheet = ss.insertSheet('Merchants');
  sheet.appendRow(['RawName', 'Nickname', 'DefaultCategory', 'Ambiguous', 'Recurring', 'Frequency', 'PaymentsLeft']);
  Logger.log('Merchants tab created.');
}

// handleChat — proxies a conversation to the Claude API.
// body.messages  : [{role:'user'|'assistant', content:'...'}]
// body.system    : optional system prompt string
// body.fileBase64: optional base64-encoded PDF
function handleChat(body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured in Script Properties' };

  var messages = body.messages || [];
  var system   = body.system   || '';

  var claudeMessages = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (i === messages.length - 1 && m.role === 'user' && body.fileBase64) {
      claudeMessages.push({
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.fileBase64 } },
          { type: 'text', text: m.content || 'Please analyze this document.' }
        ]
      });
    } else {
      claudeMessages.push({ role: m.role, content: m.content });
    }
  }

  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: system,
      messages: claudeMessages
    }),
    muteHttpExceptions: true
  });

  var data = JSON.parse(resp.getContentText());
  if (data.error) return { error: data.error.message };
  if (!data.content || !data.content[0]) return { error: 'Empty response from Claude' };
  return { reply: data.content[0].text };
}
