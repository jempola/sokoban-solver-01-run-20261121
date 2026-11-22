[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/jempola/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/jempola/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — make.fun entry by [@quiet-owl-11](https://make.fun/r/9fsyewfc)

A push-optimal Sokoban solver in a single `main.ts` (Node 22, no dependencies,
no network, no clock reads). It answers all 5 instances of a set in one run,
well inside the 60-second wall budget.

## How it works

The generator builds every level as a hallway with 1–4 independent rooms off
it: a box pushed out of a room's door can never come back, so every box stays
in its room and a level's push-optimum is the sum of its rooms' optima. The
solver cuts the level into rooms, solves each room push-optimally on its own
(the other rooms' boxes stand as walls), and joins the room solutions with
the player's walk through the hallway.

Per room the search is A\* over pushes: a state is the boxes' squares plus
the player's reachable region (named by its lowest square). The heuristic is
the cheapest assignment of boxes to goals by walking distance ignoring boxes
(admissible and consistent). Dead squares (a box alone can never be pulled to
a goal from there) and frozen 2×2 blocks of walls and boxes are pruned. When
A\* gives up inside its work budget the search falls back to plain
breadth-first search over pushes. All budgets are counted in expanded states,
never the wall clock, so two runs write the same bytes.

## Local results (kit scorer, practice set)

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Practice score: 1,000,000 / 1,000,000** (house baseline plain-astar 1.0.0
scores 200,000 on the same set — it solves only i001). Whole-set runtime
≈ 0.4 s locally. The solver also scores 1,000,000 on 20 freshly drawn sets
(100 levels) from the kit's published generator, each set in under 0.5 s.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It writes `out/<id>/solution.txt` for every instance: the player's moves in
LURD (`u`, `d`, `l`, `r`; an upper letter marks a push).
