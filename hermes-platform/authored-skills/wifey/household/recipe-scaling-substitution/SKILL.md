---
name: recipe-scaling-substitution
description: "Scale recipes up/down by servings, convert between weight and common Filipino kitchen volume measures, and give honest local ingredient substitutions when something isn't at the palengke or supermarket. Use for any 'make this for N people', 'I don't have X', or 'how much is X in cups' cooking question."
triggers:
  - user wants to scale a recipe to a different number of servings
  - user is missing an ingredient and needs a substitute
  - user asks to convert grams/ml to cups/tbsp or vice versa
  - user asks how to prep or batch a dish ahead
metadata:
  hermes:
    tags: [household, cooking, filipino, recipes, scaling, substitution]
    related_skills: []
---

# Recipe Scaling & Filipino Substitutions

Practical home-kitchen help: change the yield, convert the measures, and swap what's
not on hand — using what's actually available at the palengke and the neighbourhood
supermarket. Assume a regular home kitchen, no specialty equipment, unless told
otherwise.

## Scaling by servings

- **Scale factor = desired servings ÷ original servings.** Multiply each ingredient.
- **Scales linearly:** main ingredients, liquids, most seasonings (taste at the end).
- **Does NOT scale linearly — adjust by judgement:**
  - **Salt, fish sauce (patis), bagoong, strong spices:** start at ~0.7× the linear
    amount and adjust to taste — they intensify faster than they dilute.
  - **Leavening (baking powder/soda), yeast:** roughly linear but watch large
    batches; over-leavening collapses.
  - **Cooking time:** barely changes with quantity; **pan size and heat** do. A
    doubled adobo needs a wider pot, not double the time — or it steams instead of
    browning.
  - **Thickeners (cornstarch, flour slurry):** scale, but add gradually — you can
    always add more.
- **Round to practical amounts** (you can't measure 1.37 eggs — say "1 large + a
  splash of beaten egg, or round to 1").

## Weight ↔ volume (common PH pantry, approximate)

| Ingredient | 1 cup ≈ | 1 tbsp ≈ |
|------------|--------:|---------:|
| Water / milk | 240 ml | 15 ml |
| All-purpose flour | 120 g | 8 g |
| White sugar | 200 g | 12.5 g |
| Brown sugar (packed) | 180 g | 11 g |
| Rice (uncooked) | 185 g | — |
| Cooking oil | 220 g | 14 g |
| Salt (fine) | — | 18 g |
| Soy sauce / patis | 240 ml | 15 ml |

Eggs: 1 large ≈ 50 g (≈ 3 tbsp beaten). When a recipe is in grams and the cook has
only cups, convert and **say it's approximate** — baking is less forgiving than
cooking, so for baking, weigh if a scale is available.

## Honest Filipino substitutions

Give a substitute **and** what it changes in the dish — never pretend a swap is
identical.

| Missing | Use instead | What changes |
|---------|-------------|--------------|
| Buttermilk | 1 cup milk + 1 tbsp suka (vinegar) or calamansi, rest 10 min | fine for baking/marinades |
| Lemon | **Calamansi** (≈2–3 per lemon) or dayap | brighter, more floral; great locally |
| Heavy cream | Evaporated milk (+ a little butter) or all-purpose cream | thinner; won't whip |
| Mirin | Suka or pineapple juice + a pinch of sugar | less depth, close enough |
| Shallot | Red sibuyas (onion), smaller amount | a touch sharper |
| Fresh herbs | ⅓ the amount dried | add earlier in cooking |
| Worcestershire | Toyo (soy) + a dash of suka + pinch sugar | umami-close |
| Cake flour | APF − 2 tbsp per cup + 2 tbsp cornstarch | softer crumb |
| Wine (cooking) | Stock + splash of suka, or pineapple juice | removes alcohol, keeps acidity |
| Butter (in savoury) | Margarine or oil (¾ the volume for oil) | less richness |

For anything genuinely regional (e.g. specific gata fat content, specific isda),
ask what's at their palengke rather than guessing — availability beats theory.

## Prep-ahead & food safety (quiet but firm)

- Say what can be done early (marinades overnight, sauces, chopping) vs what must be
  last-minute (frying, anything that goes soggy).
- **Danger zone 4–60°C:** don't leave cooked food out >2 hours (>1 hour in PH heat).
- Cooked leftovers: fridge ≤4 days, reheat to steaming. Raw chicken: separate board,
  wash hands and surfaces, never rinse it in the sink (splashes spread bacteria).

## How to answer

Lead with the scaled ingredient list (or the substitution), then the one or two
adjustments that actually matter (heat/pan size, season-to-taste, bake-vs-cook
precision), then any prep-ahead note. Keep it to what the cook needs — not a lecture.
