require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // required for secure session cookies behind Railway's proxy

// ─── Config ──────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CLIENT_ID      = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI;
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'tm-session-secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getAuthClient(req) {
  const client = createOAuth2Client();
  client.setCredentials(req.session.tokens);
  client.on('tokens', (newTokens) => {
    req.session.tokens = { ...req.session.tokens, ...newTokens };
  });
  return client;
}

function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const client = createOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));
  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2.userinfo.get();
    res.json({ name: data.name, email: data.email, picture: data.picture });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sheets helpers ───────────────────────────────────────────────────────────
async function getSheetMeta(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return res.data.sheets.map(s => ({ title: s.properties.title, sheetId: s.properties.sheetId }));
}

async function readSheet(auth, tabName) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A:AZ`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0];
  const dataRows = rows.slice(1)
    .map((row, idx) => {
      const data = {};
      headers.forEach((h, i) => { data[h] = row[i] !== undefined ? row[i] : ''; });
      return { rowIndex: idx + 2, data };
    })
    .filter(r => Object.values(r.data).some(v => v !== '')); // skip fully empty rows
  return { headers, rows: dataRows };
}

async function appendRow(auth, tabName, headers, rowData) {
  const sheets = google.sheets({ version: 'v4', auth });
  const values = [headers.map(h => rowData[h] !== undefined ? rowData[h] : '')];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

async function updateRow(auth, tabName, rowIndex, headers, rowData) {
  const sheets = google.sheets({ version: 'v4', auth });
  const values = [headers.map(h => rowData[h] !== undefined ? rowData[h] : '')];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function deleteRow(auth, tabName, rowIndex) {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await getSheetMeta(auth);
  const sheet = meta.find(s => s.title === tabName);
  if (!sheet) throw new Error(`Tab "${tabName}" not found`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }],
    },
  });
}

async function findRowById(auth, tabName, id) {
  const { headers, rows } = await readSheet(auth, tabName);
  const idField = headers.includes('ID') ? 'ID' : 'Review_ID';
  const row = rows.find(r => String(r.data[idField]) === String(id));
  return row ? { rowIndex: row.rowIndex, data: row.data, headers } : null;
}

async function getNextId(auth, tabName) {
  const { headers, rows } = await readSheet(auth, tabName);
  const idField = headers.includes('ID') ? 'ID' : 'Review_ID';
  let maxId = 0;
  for (const row of rows) {
    const n = parseInt(row.data[idField] || '0', 10);
    if (!isNaN(n) && n > maxId) maxId = n;
  }
  return maxId + 1;
}

function today() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
}

// Convert DD-MM-YYYY → YYYY-MM-DD for Google Calendar API
function toIsoDate(dateStr) {
  if (!dateStr) return dateStr;
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    const [dd, mm, yyyy] = dateStr.split('-');
    return `${yyyy}-${mm}-${dd}`;
  }
  return dateStr;
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────
function parseDuration(str) {
  if (!str) return null;
  if (/^\d+$/.test(str.trim())) return parseInt(str, 10);
  let mins = 0;
  const h = str.match(/(\d+(?:\.\d+)?)\s*h/i);
  const m = str.match(/(\d+)\s*m/i);
  if (h) mins += parseFloat(h[1]) * 60;
  if (m) mins += parseInt(m[1], 10);
  return mins || null;
}

function addMinutes(dateTimeStr, minutes) {
  // Parse naive datetime string (YYYY-MM-DDTHH:MM:SS) without any timezone conversion.
  // Use Date.UTC so arithmetic is timezone-independent, then read back as UTC.
  const [datePart, timePart] = dateTimeStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [h, m] = timePart.split(':').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, h, m + minutes));
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}

// Google Calendar all-day events require end = start + 1 day (exclusive)
function nextIsoDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function syncCalendar(auth, rowData, tabName, rowIndex, headers) {
  const calendar = google.calendar({ version: 'v3', auth });
  const execDate = toIsoDate((rowData['Execution_Date'] || '').trim());
  const calId = (rowData['Calendar_Event_ID'] || '').trim();

  // Remove event only if Execution_Date is cleared
  if (!execDate) {
    if (calId) {
      try { await calendar.events.delete({ calendarId: 'primary', eventId: calId }); } catch (_) {}
      const updated = { ...rowData, Calendar_Event_ID: '' };
      await updateRow(auth, tabName, rowIndex, headers, updated);
      return updated;
    }
    return rowData;
  }

  const execTime = (rowData['Execution_Time'] || '').trim();
  const duration = rowData['Estimated_Duration'];
  let eventBody = { summary: rowData['Name'] || '(no title)', description: rowData['Notes'] || '' };

  if (execTime) {
    const timeStr = execTime.length === 5 ? execTime + ':00' : execTime;
    const startDT = `${execDate}T${timeStr}`;
    const durationMins = parseDuration(duration) || 60;
    const endDT = addMinutes(startDT, durationMins);
    eventBody.start = { dateTime: startDT, timeZone: 'Europe/Paris' };
    eventBody.end = { dateTime: endDT, timeZone: 'Europe/Paris' };
  } else {
    eventBody.start = { date: execDate };
    eventBody.end = { date: nextIsoDay(execDate) };
  }

  let newCalId = calId;
  if (calId) {
    try {
      await calendar.events.update({ calendarId: 'primary', eventId: calId, requestBody: eventBody });
    } catch (_) {
      const r = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
      newCalId = r.data.id;
    }
  } else {
    const r = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
    newCalId = r.data.id;
  }

  if (newCalId !== calId) {
    const updated = { ...rowData, Calendar_Event_ID: newCalId };
    await updateRow(auth, tabName, rowIndex, headers, updated);
    return updated;
  }
  return rowData;
}

// ─── API routes ───────────────────────────────────────────────────────────────
app.get('/api/tabs', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const meta = await getSheetMeta(auth);
    res.json(meta.map(s => s.title));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data/:tab', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const data = await readSheet(auth, req.params.tab);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/row/:tab', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const { tab } = req.params;
    const rowData = { ...req.body.data };

    const { headers } = await readSheet(auth, tab);
    const idField = headers.includes('ID') ? 'ID' : 'Review_ID';
    rowData[idField] = String(await getNextId(auth, tab));

    const t = today();
    if (headers.includes('Created_Date') && !rowData['Created_Date']) rowData['Created_Date'] = t;
    if (headers.includes('Last_Modified')) rowData['Last_Modified'] = t;

    await appendRow(auth, tab, headers, rowData);

    // Calendar sync for new rows with Execution_Date
    if (rowData['Execution_Date'] && tab !== 'Inbox' && tab !== 'Michel_Review') {
      const { rows } = await readSheet(auth, tab);
      const newRow = rows.find(r => String(r.data[idField]) === String(rowData[idField]));
      if (newRow) await syncCalendar(auth, newRow.data, tab, newRow.rowIndex, headers);
    }

    res.json({ success: true, id: rowData[idField] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/row/:tab/:id', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const { tab, id } = req.params;
    const { updates } = req.body;

    const found = await findRowById(auth, tab, id);
    if (!found) return res.status(404).json({ error: 'Row not found' });

    const { rowIndex, data: existing, headers } = found;
    let updated = { ...existing, ...updates, Last_Modified: today() };

    // Archive when Done
    if (updates.Status === 'Done' && existing.Status !== 'Done') {
      updated['Completed_Date'] = today();

      // Move to Archive
      const { headers: archHeaders } = await readSheet(auth, 'Archive');
      await appendRow(auth, 'Archive', archHeaders, updated);
      await deleteRow(auth, tab, rowIndex);
      return res.json({ success: true, archived: true });
    }

    await updateRow(auth, tab, rowIndex, headers, updated);

    // Calendar sync if relevant fields changed
    const calFields = ['Execution_Date', 'Execution_Time', 'Estimated_Duration', 'Status', 'Name'];
    if (calFields.some(f => updates[f] !== undefined) && tab !== 'Inbox' && tab !== 'Michel_Review') {
      updated = await syncCalendar(auth, updated, tab, rowIndex, headers);
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/row/:tab/:id', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const { tab, id } = req.params;

    const found = await findRowById(auth, tab, id);
    if (!found) return res.status(404).json({ error: 'Row not found' });

    const { rowIndex, data } = found;

    if (data['Calendar_Event_ID']) {
      const cal = google.calendar({ version: 'v3', auth });
      try { await cal.events.delete({ calendarId: 'primary', eventId: data['Calendar_Event_ID'] }); } catch (_) {}
    }

    await deleteRow(auth, tab, rowIndex);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inbox', requireAuth, async (req, res) => {
  try {
    const auth = getAuthClient(req);
    const { name, notes } = req.body;
    const { headers } = await readSheet(auth, 'Inbox');
    const nextId = await getNextId(auth, 'Inbox');
    const rowData = {
      'ID': String(nextId),
      'Name': name || '',
      'Notes': notes || '',
      'Created_Date': today(),
    };
    await appendRow(auth, 'Inbox', headers, rowData);
    res.json({ success: true, id: nextId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Task Manager running at http://localhost:${PORT}`);
});
