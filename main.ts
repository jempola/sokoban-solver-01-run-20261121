// Sokoban solver entry for make.fun sokoban-solver-01-run-20261121.
//
// Strategy: the generator lays a hallway with 1-4 independent rooms off it
// (a box pushed out of a room's door can never come back, so every box stays
// in its room and a level's push-optimum is the sum of its rooms' optima).
// Each room is solved push-optimally on its own, with the other rooms'
// boxes standing as walls, and the room solutions are joined by the
// player's walk through the hallway.
//
// Per room the search is A* over pushes: a state is the boxes' squares plus
// the player's reachable region (named by its lowest square). The heuristic
// is the cheapest assignment of boxes to goals by walking distance ignoring
// boxes (admissible and consistent: one push moves one box one square, so it
// changes by at most 1). Dead squares (a box alone can never be pulled to a
// goal from there) and frozen 2x2 blocks of walls and boxes are pruned.
// When A* gives up inside its work budget the search falls back to plain
// breadth-first search over pushes, the same shape the kit's own reference
// solver uses.
//
// Budgets are counted in expanded states, never the wall clock: two runs
// write the same bytes. No randomness, no environment read other than the
// input/output directories the kit's starter already reads.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, in states expanded: never the clock, so runs are identical. */
const ASTAR_EXPANSIONS_PER_ROOM = 400_000;
const ASTAR_STATES_PER_ROOM = 600_000;
const BFS_EXPANSIONS_PER_ROOM = 250_000;
const BFS_STATES_PER_ROOM = 250_000;
/** Whole-run ceiling across all five instances, same reason. */
const GLOBAL_EXPANSION_BUDGET = 2_500_000;
let expansionsUsed = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pulled back onto some goal. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` boxes in the way; returns the lowest. */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n] as number;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters; null when unreachable. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

/** All orderings of 0..n-1 (n is at most 4 here, so at most 24). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      const tmp = a[k] as number;
      a[k] = a[i] as number;
      a[i] = tmp;
      gen(k + 1);
      const tmp2 = a[k] as number;
      a[k] = a[i] as number;
      a[i] = tmp2;
    }
  };
  gen(0);
  return out;
}

const encodeBoxes = (boxes: number[]): number => {
  let code = 0;
  for (const b of boxes) code = code * 1000 + b;
  return code;
};

function decodeBoxes(code: number, n: number): number[] {
  const boxes = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    boxes[i] = code % 1000;
    code = Math.floor(code / 1000);
  }
  return boxes;
}

/**
 * Push-optimal search over one level (a room's sub-level, or a whole level):
 * { pushes, moves } (moves in LURD, a lower letter a step, an upper one a
 * push), or null when the search gives up inside its work budget.
 * A* with the box-to-goal assignment heuristic; with useHeuristic false it
 * is plain breadth-first search over pushes.
 */
function solvePush(
  level: Level,
  maxExpansions: number,
  maxStates: number,
  useHeuristic: boolean,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const n = level.boxes.length;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  // Walking distance from every square to each goal, ignoring boxes.
  const dist = new Int32Array(size * n).fill(-1);
  for (let gi = 0; gi < n; gi++) {
    const start = goals[gi] as number;
    dist[start * n + gi] = 0;
    const queue = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi] as number;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q * n + gi] < 0) {
          dist[q * n + gi] = dist[p * n + gi] + 1;
          queue.push(q);
        }
      }
    }
  }
  const perms = permutations(n);
  const heur = (boxes: number[]): number => {
    if (!useHeuristic) return 0;
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[(boxes[i] as number) * n + (p[i] as number)];
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // Binary heap on [f, h, sequence, state]: lower f first, then lower h,
  // then the earlier sequence, so ties break the same way every run.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i] as [number, number, number, number], heap[p] as [number, number, number, number])) break;
      const tmp = heap[i] as [number, number, number, number];
      heap[i] = heap[p] as [number, number, number, number];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0] as [number, number, number, number];
    const last = heap.pop() as [number, number, number, number];
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1] as [number, number, number, number], heap[c] as [number, number, number, number])) c++;
        if (!less(heap[c] as [number, number, number, number], heap[i] as [number, number, number, number])) break;
        const tmp = heap[i] as [number, number, number, number];
        heap[i] = heap[c] as [number, number, number, number];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  // The states: their boxes (one number), the player's square, the key
  // (boxes + the lowest square of the player's reachable region), the
  // cheapest pushes so far, and the push that made them from their parent.
  const sBoxes: number[] = [encodeBoxes(level.boxes)];
  const sPlayer: number[] = [level.player];
  const sKey: number[] = [0];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const best = new Map<number, number>();
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const key0 = encodeBoxes(level.boxes) * 1000 + low0;
  sKey[0] = key0;
  best.set(key0, 0);
  let seq = 0;
  heapPush([heur(level.boxes), heur(level.boxes), seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (best.get(sKey[s] as number) !== sG[s]) continue; // a cheaper path to this state came later
    const boxes = decodeBoxes(sBoxes[s] as number, n);
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions || expansionsUsed >= GLOBAL_EXPANSION_BUDGET) break;
    expanded++;
    expansionsUsed++;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[s] as number, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi] as number;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let h2 = 0;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h2 = heur(next);
          if (h2 < Infinity) {
            const low = reach(level, occupied, b, mark, ++stamp, stack);
            key = encodeBoxes(next) * 1000 + low;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h2 === Infinity || key < 0) continue;
        const g2 = (sG[s] as number) + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g2) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(encodeBoxes(next as number[]));
        sPlayer.push(b);
        sKey.push(key);
        sG.push(g2);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        heapPush([g2 + h2, h2, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const from = sFrom[s] as number;
    const to = sTo[s] as number;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d) as readonly [number, number, string, string];
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk + dir[3];
    player = from;
    boxes = decodeBoxes(sBoxes[s] as number, n);
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = (squares[i] as number) + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) (rooms[part[b] as number] as Room).boxes.push(b);
  for (const g of goals) if (part[g] >= 0) (rooms[part[g] as number] as Room).goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one room push-optimally: A* first, breadth-first search as fallback. */
function solveRoom(level: Level, maxExpansions: number, maxStates: number): { pushes: number; moves: string } | null {
  const astar = solvePush(level, maxExpansions, maxStates, true);
  if (astar !== null) return astar;
  return solvePush(level, BFS_EXPANSIONS_PER_ROOM, BFS_STATES_PER_ROOM, false);
}

/**
 * Solve a level room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. Falls
 * back to a search over the whole level when it is no set of rooms.
 */
function solveLevel(level: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solveRoom(level, ASTAR_EXPANSIONS_PER_ROOM, ASTAR_STATES_PER_ROOM);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub, ASTAR_EXPANSIONS_PER_ROOM, ASTAR_STATES_PER_ROOM);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    // The player's square after the room's moves.
    for (const ch of solved.moves.toLowerCase()) {
      player += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
    }
    room.done = true;
  }
  return { pushes, moves };
}

for (const id of readdirSync(I).sort()) {
  const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  const solved = solveLevel(level);
  const moves = solved === null ? '' : solved.moves;
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
