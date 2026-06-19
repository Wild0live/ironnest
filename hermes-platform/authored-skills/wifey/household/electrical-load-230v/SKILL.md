---
name: electrical-load-230v
description: "Size circuits, breakers, and wire for Philippine 230V single-phase residential work — load calculation, breaker/wire matching, voltage-drop, and the DIY-vs-licensed-electrician line. Use for any 'what breaker / what wire / can this circuit handle' question."
triggers:
  - user asks what breaker size or wire gauge to use
  - user asks if a circuit/outlet can handle an appliance (aircon, heater, oven)
  - user reports a tripping breaker or warm/hot outlet or wire
  - user is adding an outlet, circuit, or appliance and needs it sized
  - user asks about voltage drop on a long run
metadata:
  hermes:
    tags: [household, electrical, safety, philippines, 230v, load-calculation]
    related_skills: [household-solar-array-compatibility]
---

# Philippine 230V Residential Load Sizing

Philippine homes run **230V single-phase, 60Hz**. Every number here assumes 230V —
not 120V. The job is to size a circuit so the **breaker protects the wire** and the
wire comfortably carries the load, and to say plainly when the work crosses the line
to a licensed electrician.

## Safety gate first — say this before any calculation that implies work

- **Breaker OFF, then verify dead with a tester** before touching any conductor.
  Never trust the switch or the label.
- This skill **sizes** circuits and guides outlet/breaker/fixture-level work. It does
  **not** authorize: **main panel / service-entrance changes, adding a new breaker to
  a live panel, re-wiring, or anything with scorch marks or a burning smell.** Those
  are licensed-electrician work — say so directly.
- If the calculation reveals the existing wire is **undersized for its breaker**,
  that is a fire risk that exists right now — flag it as the headline, not a footnote.

## Core relationships (230V)

- **Current:** `I (A) = P (watts) ÷ 230`. (e.g. 2300W ÷ 230 = 10 A.)
- **Continuous loads** (aircon, water heater, anything on >3h): size the circuit to
  **125%** of the running current, i.e. load should not exceed **80%** of the breaker
  rating. A 16A breaker is good for ~12.8A continuous.
- **Breaker protects the wire:** the breaker rating must be **≤** the wire's safe
  ampacity. Never put a bigger breaker on to "stop nuisance trips" — that defeats the
  protection and is the classic cause of overheated wiring.

## Breaker ↔ copper wire (THHN, residential, typical PH practice)

| Breaker | Min copper wire | Typical use (230V) |
|--------:|-----------------|--------------------|
| 15–16 A | 2.0 mm² (14 AWG) | lighting, general outlets |
| 20 A    | 3.5 mm² (12 AWG) | kitchen outlets, small aircon (~1.0 HP) |
| 30 A    | 5.5 mm² (10 AWG) | 1.5–2.0 HP aircon, water heater |
| 40–50 A | 8.0 mm² (8 AWG)  | large aircon, range, sub-feed |
| 60 A    | 14 mm² (6 AWG)   | sub-panel feed |

Always size to the **next wire up** if the run is long or bundled/in-conduit in hot
ceiling space (tropical derating — see below). When old wire size is unknown, ask for
a photo of the conductor printing or the panel.

## Appliance quick-reference (230V running current)

| Appliance | Approx watts | Approx amps | Suggested dedicated circuit |
|-----------|-------------:|------------:|-----------------------------|
| 1.0 HP aircon (inverter) | ~900W | ~4 A | 20 A / 3.5 mm² |
| 1.5 HP aircon | ~1100–1400W | ~5–6 A | 20–30 A / 3.5–5.5 mm² |
| 2.0 HP aircon | ~1800W | ~8 A | 30 A / 5.5 mm² |
| Electric water heater (instant) | 3500–5500W | 15–24 A | 30–40 A / 5.5–8.0 mm² |
| Microwave | ~1200W | ~5 A | shared 20 A OK |
| Electric oven/range | 2000–3000W | 9–13 A | dedicated 20–30 A |
| Rice cooker / kettle | ~700–1500W | 3–7 A | shared 20 A OK |

Big heat loads (water heater, oven, aircon ≥1.5HP) get a **dedicated circuit** — do
not chain them onto a shared outlet line.

## Tropical / PH realities

- **Heat derating:** wire in hot ceiling cavities and bundled conduit carries less
  than its rated ampacity. In doubt, go one size up.
- **Brownout surges & undersized old wiring** are common — if the house is old and the
  load is new and heavy, suspect the existing branch wire is the weak link.
- **Hard water + corrosion** near water heaters: check the ground and bonding, not
  just the conductor.

## Diagnosing a tripping breaker (in order)

1. **Overload** — too much on the circuit. Add up the loads; compare to 80% of the
   breaker. Most common cause.
2. **Short circuit** — trips instantly, every time, even with loads off → stop, this
   is a fault; isolate the circuit and inspect/call a pro.
3. **Ground fault** — trips a GFCI/RCD, often in wet areas → real fault, don't bypass.
4. **Weak/old breaker** — trips below rating after years of heat. Replace like-for-like
   (same rating), never upsize to mask a real overload.

## How to answer

Give: the current draw, the matching breaker, the **minimum wire**, whether it needs a
dedicated circuit, and the one safety check that matters most for this job. If a photo
of the panel or conductor would change the answer, ask for it before committing to a
number. Label the temporary-fix vs proper-fix honestly, and name the shutoff to close
before any hands-on step.
