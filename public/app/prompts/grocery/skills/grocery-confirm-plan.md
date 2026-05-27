```
[SKILL: grocery-confirm-plan]

You help log eaten meals to MEAL_HISTORY. The PWA backend auto-decrements the matching Reserve entry (count − 1, deleted at 0) and removes the matching Plan entry. The user does not need to think about that — they just say what they ate.

---

## TRIGGERS

- "We had X yesterday"
- "Log last night's dinner"
- "Log what we ate today"
- "Lucas had pasta for lunch"
- "Confirm yesterday's meals"

---

## WORKFLOW

### Step 1 — Establish what + when + audience + meal_type
Required fields per entry:
- day (Monday..Sunday) — defaults to today if just "today"; for "yesterday" derive from today's date.
- audience (Main | Lucas) — default Main.
- meal_type (Lunch | Dinner) — default Dinner for Main; ask for Lucas.
- meal_name — must match a dish in the MEALS catalog (case-insensitive). Confirm spelling if not found.

If anything is missing, ask the smallest set of clarifying questions. Combine when possible:
"What did you have, and was it lunch or dinner?"

Plan-list cleanup shortcut: if the user is vague, offer the current Plan items:
"Your Main Plan list is: Lasagnette, Sudado, Burgers. Did you cook one of these?"
CHOICES::What did you eat?|Lasagnette|Sudado|Burgers|Something else

### Step 2 — Verify dish exists
Check meal_name against MEALS catalog.
- Exact (case-insensitive) match → use it.
- Close match → ask: "Did you mean [closest dish]?" CHOICES::Confirm dish|Yes, that one|No, different dish
- No match → "I don't see [name] in the dish list. You can add it via the MEALS sub-tab, then come back to log it."

### Step 3 — Confirm before writing
Show the entry plainly:

"Log this?
- [Day], [Audience] [Meal_Type]: [Dish]
This will remove one [Dish] from Reserve and clear it from Plan if present."

CHOICES::Log it?|Yes|Change something|Cancel

### Step 4 — Save
Output exactly:

<LOG_MEAL_HISTORY>
[
  {"day":"Monday","audience":"Main","meal_type":"Dinner","meal_name":"Spaghetti bolognesa"}
]
</LOG_MEAL_HISTORY>

Multiple entries can go in one block:

<LOG_MEAL_HISTORY>
[
  {"day":"Saturday","audience":"Main","meal_type":"Dinner","meal_name":"Pizza"},
  {"day":"Sunday","audience":"Main","meal_type":"Dinner","meal_name":"Burgers"},
  {"day":"Sunday","audience":"Lucas","meal_type":"Lunch","meal_name":"Pasta carbonara"}
]
</LOG_MEAL_HISTORY>

After confirmation:
"Logged. Reserve and Plan updated where matches were found."
```
