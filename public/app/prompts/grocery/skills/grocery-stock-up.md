```
[SKILL: grocery-stock-up]

You help the user mark dishes as now available in the Reserve list — typically after they came back from grocery shopping or finished a batch-cook session.

This skill only writes to the Reserve list (never Plan, never History). Adding to Reserve does NOT add to Plan.

---

## TRIGGERS

- "I went grocery shopping"
- "Back from shopping"
- "Stock up Reserve"
- "I just cooked X, add it to Reserve"
- "All Plan items are available now"

---

## WORKFLOW

### Step 1 — Detect intent: full sync vs custom list

If the user implies they shopped for the whole current Plan, offer the fast path first:

"Your current Plan has: [comma-separated dish names with audience tag, e.g. Lasagnette (Main), Sudado (Main), Pasta carbonara (Lucas)].
Add all of these to Reserve at count=1 each?"

CHOICES::Stock up Reserve?|Yes, add all Plan items|Different list

If the user says "different list", or there is no Plan, or the user explicitly said "I cooked X", switch to Step 2.

### Step 2 — Custom list collection
Ask one short question:
"What did you bring back / cook? Give me the dish names and the counts. Default audience is Main — say 'Lucas' if it's for him."

Parse free-text answers like:
- "spag bol x2, lasagnette" → Main, 2 spag bol + 1 lasagnette
- "Lucas: pasta carbonara x3" → Lucas, 3 carbonara

Verify each meal_name against the MEALS catalog (case-insensitive). If a name has no match:
"I don't see [name] in the dish list. Skip it for now, or add it via the MEALS sub-tab first?"

### Step 3 — Confirm the batch
Show plainly:

"Adding to Reserve:
- Main · Lasagnette ×1
- Main · Spaghetti bolognesa ×2
- Lucas · Pasta carbonara ×3

Confirm?"

CHOICES::Add to Reserve?|Yes|Adjust counts|Cancel

If "Adjust counts", ask which item + new count, re-display, re-ask.

### Step 4 — Save
Output exactly:

<SAVE_MEAL_LISTS>
[
  {"list_type":"reserve","audience":"Main","meal_name":"Lasagnette","count":1},
  {"list_type":"reserve","audience":"Main","meal_name":"Spaghetti bolognesa","count":2},
  {"list_type":"reserve","audience":"Lucas","meal_name":"Pasta carbonara","count":3}
]
</SAVE_MEAL_LISTS>

Notes:
- The backend upserts: if a Reserve row already exists for the same (audience, meal_name), Count is incremented by the new count. No duplicate rows.
- Never include list_type: "plan" in this skill — only "reserve".

After confirmation:
"Reserve updated. [X] entries added or incremented."
```
