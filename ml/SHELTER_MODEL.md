# Shelter model for existing buildings (ML proposal for Simulation)

The plan phase lets the user turn **existing buildings** into tornado shelters. Simulation owns the rules in `sim/params/protections.json` and `sim/core/protections.ts`; this file proposes the values and shows they work on the Lumberton demo. Numbers reuse the sources already in `sim_params.sources.md` wherever possible.

## Proposed rule

| Setting | Value | Source / reason |
|---|---|---|
| Which buildings can become shelters | `SCHOOL`, `WORSHIP`, `COMMERCIAL`, `BIGROOF` | Public or commercial buildings people can enter. Homes, apartments and `OTHER` are excluded. |
| Hardened area | 25% of the building's footprint (`footprint_sqft`) | Model choice: a hardened interior core (corridors, gym, interior rooms), built to FEMA P-361 / ICC 500. |
| Capacity | hardened area / 5 sq ft, clamped to 50–1,000 people | [FEMA P-361](https://www.fema.gov/node/what-minimum-square-footage-person-tornado-community-safe-room): 5 sq ft per tornado occupant |
| Cost | $1,500 × capacity | Same per-occupant cost as the current safe room (FEMA-funded rooms ~$1,045/person, vendors $1,500–2,000). Replace with the Story lead's sourced figure. |
| Who goes there | Mobile-home residents within reach, at 30% compliance, plus the building's own occupants | Chaney & Weaver 2010 (already in sources) |
| Reach | walk 1.07 m/s × (warning − 5 min) = 321 m at 10 min | Already in sources |
| Death risk inside | 0 | P-361 rooms are designed for 250 mph winds |
| Filling | Nearest homes first; nobody assigned twice; stop at capacity | Same as current `assignShelters` |

**Data needed from Structures:** add `footprint_sqft` (NSI `ftprntsqft`) to each record in `buildings.json`. It is already in the raw NSI frame.

## What to show on each candidate building (for the plan UI)

- Type and footprint
- Capacity (people)
- Cost
- People within walking reach, and how many are in mobile homes
- **Lives saved if converted**: engine `expected()` with and without this one building, for the current storm. This is the "how effective" number. It depends on the storm path, so compute it live, not from a table.

## Check on the Lumberton demo storm (EF3, 2 AM, 10 min warning)

Baseline: 18.86 expected deaths, 18.71 in mobile homes. At 30% compliance, **the most any shelter plan can save is about 5.6**. That's a real finding, and the score screen should frame it that way: warning and willingness to go matter as much as the buildings.

- 2,643 eligible buildings have a footprint; **721** are within 321 m of mobile homes.
- Best single buildings, from `ml/shelter_candidates.py`:

| Building | Type | Capacity | Cost | Lives saved alone |
|---|---|---|---|---|
| nsi_56640865 | Commercial, 6,955 sq ft | 347 | $520,500 | 3.29 |
| nsi_56677799 | Church, 2,596 sq ft | 129 | $193,500 | 2.70 |
| nsi_56638583 | Commercial, 14,170 sq ft | 708 | $1,062,000 | 1.52 |

The trade-offs are real: location beats size. A small church next to the mobile-home park saves more than a large church across town at a sixth of the cost. That is the decision the plan phase should teach.

## Limits

- The 25% hardened share is a model choice. It sets capacity and cost together, so it changes which buildings look attractive, not the lives-saved ceiling.
- Compliance is from mobile-home studies; applying 30% to everyone within reach is an assumption.
- Lives saved are model estimates for one storm, not proven causal effects.
