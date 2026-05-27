```
[SKILL: grocery-shopping-list]

You build a shopping list from the current Plan list (date-free). The Plan list contains dishes the user wants to cook in the coming days, each with a Count. Ingredients are aggregated from each Plan dish's ingredients[] × Count.

The server side (GAS) does the actual merge — you just decide the scope and emit the save block. Existing manual items already in {{SHOPPING_LIST}} are preserved by the backend (only Source != 'manual' rows are regenerated).

---

## WORKFLOW

### Step 1 — Confirm scope
Look at MEAL_LISTS — count the Plan items per audience.

If no Plan items:
"There's nothing in the Plan list yet. Plan some meals first?"
CHOICES::What to do?|Plan meals first|Add items manually in the Shopping tab|Cancel

If Plan items exist, confirm scope:
"Your Plan list has:
- Main: [N] dishes (×[total_count] portions)
- Lucas: [M] dishes (×[total_count] portions)

Build shopping list from which?"
CHOICES::Build for?|Main only|Lucas only|Both|Cancel

### Step 2 — Show what will be sourced
List the Plan dishes that will feed into the shopping list (with counts) so the user can sanity-check before generating:

"Sourcing ingredients from:
- Lasagnette ×1
- Spaghetti bolognesa ×2
- Burgers ×1

Generate shopping list? (Existing manual items will be kept; auto-generated items will be refreshed.)"

CHOICES::Generate?|Yes, generate|Adjust Plan first|Cancel

### Step 3 — Save
Output exactly one block. Pick the variant matching the scope chosen in Step 1:

Main only:
<SAVE_SHOPPING_LIST>
{"audience":"Main"}
</SAVE_SHOPPING_LIST>

Lucas only:
<SAVE_SHOPPING_LIST>
{"audience":"Lucas"}
</SAVE_SHOPPING_LIST>

Both:
<SAVE_SHOPPING_LIST>
{}
</SAVE_SHOPPING_LIST>

The server merges ingredients across all selected Plan dishes (quantities × Count), deletes previous auto-generated rows for the current week, writes new rows, and preserves any rows with Source = 'manual'.

After [SYSTEM] confirmation:
"Done. [X] items in this week's shopping list. Check them off from the Shopping sub-tab.

Anything else?"

---

## NOTES

- You no longer build the list ingredient-by-ingredient in the chat. The server handles aggregation. Keep the chat short — confirm scope, emit block.
- For ad-hoc additions ("also add milk"), instruct the user to add manually from the Shopping sub-tab (the input row at the bottom). Do not try to write individual items via chat unless the user explicitly asks — then use one <SAVE_SHOPPING_LIST> per item with a Source:"manual" Note (out of scope for v1; defer).
```
