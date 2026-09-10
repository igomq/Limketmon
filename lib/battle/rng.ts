// Deterministic PRNG for the battle engine. mulberry32: a 32-bit-state integer
// PRNG with a full 2^32 period, uniform doubles in [0,1), and plain integer
// math (no BigInt), so Node and workerd produce bit-identical sequences.
//
// The whole engine derives randomness from BattleState.rng, so a replay only
// needs the seed plus the decision list.

/** The slice of state the PRNG reads and writes. BattleState satisfies it. */
export interface RngState {
  /** Mutable 32-bit PRNG word. */
  rng: number;
  /** Draws consumed so far; kept in state so replays can be diffed. */
  rngDraws: number;
}

/** Turns any number (NaN, negative, fractional, huge) into a non-zero uint32 state. */
export function seedFrom(seed: number): number {
  const word = Number.isFinite(seed) ? seed >>> 0 : 0;
  // 0 is a legal mulberry32 state but is a poor default for "no seed", so pin it to a constant.
  return word === 0 ? 0x9e3779b9 : word;
}

/** mulberry32 step. Mutates state.rng and state.rngDraws, returns [0,1). */
export function nextRandom(state: RngState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  state.rngDraws += 1;
  return value;
}

/** Uniform integer in [0, maxExclusive). maxExclusive <= 1 (or invalid) yields 0. */
export function randomInt(state: RngState, maxExclusive: number): number {
  const max = Math.floor(maxExclusive);
  if (!Number.isFinite(max) || max <= 1) return 0;
  return Math.min(max - 1, Math.floor(nextRandom(state) * max));
}
