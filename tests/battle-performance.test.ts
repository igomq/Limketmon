import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import type { BattleSetup, CombatantSeed, Decision } from '../lib/battle/types.ts';
import { advance, cloneState, createBattle } from '../lib/battle/engine.ts';
import { runBattle, stepBattle } from '../lib/battle/simulate.ts';
import { deciderFor } from '../lib/battle/ai.ts';
import { opponentById, OPPONENTS } from '../lib/battle/opponents.ts';
import { buildSetup } from '../lib/battle/setup.ts';

function unit(uid: string, side: 'a' | 'b', slot: number): CombatantSeed {
  return {
    cardId: `test-${uid}`,
    name: uid,
    rarity: 'SSR',
    element: 'nature',
    maxHp: 50000,
    atk: 10,
    def: 200,
    spd: 10 + slot,
    crit: 0,
    ability: { id: 'a', name: 'Hit', description: '', cost: 1, cooldown: 0, ops: [{ op: 'damage', power: 5 }] }
  };
}

test('incremental stepBattle produces exact state and log matching runBattle across modes', () => {
  for (const mode of ['normal', 'hard', 'chaos'] as const) {
    for (const opponent of OPPONENTS) {
      const setup = buildSetup({
        kind: 'pve',
        mode,
        opponentId: opponent.id,
        modifier: { kind: 'none' },
        seed: 42,
        playerCardIds: ['imsingyu-v001', 'imsingyu-v002', 'imsingyu-v003']
      });
      const profile = opponentById(opponent.id, mode)!.profile;
      const decider = deciderFor(profile);

      let incState = runBattle(setup, [], decider).state;
      const playerDecisions: Decision[] = [];
      const collectedEvents = [...incState.log];

      for (let step = 0; step < 50 && incState.status === 'active'; step++) {
        const uid = incState.activeUid;
        if (!uid) break;
        const decision: Decision = { uid, action: step % 2 === 0 ? 'skill' : 'attack' };
        let res = stepBattle(incState, decision, decider);
        if (res.error) {
          decision.action = 'attack';
          res = stepBattle(incState, decision, decider);
        }
        if (res.error) break;
        playerDecisions.push(decision);
        incState = res.state;
        collectedEvents.push(...res.events);
      }

      const direct = runBattle(setup, playerDecisions, decider);
      assert.deepEqual(incState, direct.state, `state mismatch for ${opponent.id} on ${mode}`);
      assert.deepEqual(collectedEvents, direct.state.log, `event log mismatch for ${opponent.id} on ${mode}`);
    }
  }
});

test('frozen state and previous event records are not mutated by advance or cloneState', () => {
  const setup: BattleSetup = {
    kind: 'pve',
    opponentId: 'sponge',
    modifier: { kind: 'none' },
    seed: 1,
    player: [unit('a0', 'a', 0)],
    opponent: [unit('b0', 'b', 0)]
  };
  const state = createBattle(setup);
  Object.freeze(state);
  Object.freeze(state.log);
  for (const combatant of [...state.sides.a, ...state.sides.b]) {
    Object.freeze(combatant);
    Object.freeze(combatant.statuses);
  }

  const cloned = cloneState(state);
  assert.equal(cloned.log.length, state.log.length);
  cloned.log.push({ t: 'warn', message: 'test mutate' });
  assert.equal(state.log.length, 1, 'original frozen log unchanged');

  const decision: Decision = { uid: state.activeUid!, action: 'attack' };
  const next = advance(state, decision);
  assert.equal(next.error, undefined);
  assert.equal(state.log.length, 1, 'original state.log unmutated by advance');
  assert.ok(next.state.log.length > state.log.length);
});

test('stepBattle rejects invalid choices without advancing or mutating state', () => {
  const setup: BattleSetup = {
    kind: 'pve',
    opponentId: 'sponge',
    modifier: { kind: 'none' },
    seed: 1,
    player: [unit('a0', 'a', 0)],
    opponent: [unit('b0', 'b', 0)]
  };
  const decider = () => ({ uid: 'b0', action: 'attack' as const });
  const state = createBattle(setup);
  const originalLogLength = state.log.length;
  const originalRngDraws = state.rngDraws;

  // 1. Wrong uid
  const wrongUid = stepBattle(state, { uid: 'wrong', action: 'attack' }, decider);
  assert.equal(wrongUid.error, 'uid');
  assert.equal(wrongUid.events.length, 0);
  assert.equal(state.log.length, originalLogLength);
  assert.equal(state.rngDraws, originalRngDraws);

  // 2. Not player side (side b uid passed to stepBattle)
  const opUid = stepBattle(state, { uid: 'b0', action: 'attack' }, decider);
  assert.equal(opUid.error, 'uid');
  assert.equal(opUid.events.length, 0);

  // 3. Ended battle rejection
  const endedState = { ...state, status: 'won' as const };
  const onEnded = stepBattle(endedState, { uid: 'a0', action: 'attack' }, decider);
  assert.equal(onEnded.error, 'ended');
  assert.equal(onEnded.events.length, 0);
});

test('benchmark 3v3 setup: incremental stepBattle outperforms quadratic repeat work', () => {
  const setup: BattleSetup = {
    kind: 'pve',
    opponentId: 'sponge',
    modifier: { kind: 'none' },
    seed: 42,
    player: [unit('a0', 'a', 0), unit('a1', 'a', 1), unit('a2', 'a', 2)],
    opponent: [unit('b0', 'b', 0), unit('b1', 'b', 1), unit('b2', 'b', 2)]
  };
  const decider = (s: typeof setup extends BattleSetup ? any : never) => ({ uid: s.activeUid, action: 'attack' as const });

  let s = createBattle(setup);
  const decisions: Decision[] = [];
  while (s.status === 'active' && decisions.length < 102) {
    const uid = s.activeUid;
    if (!uid) break;
    if (s.sides.a.some((c) => c.uid === uid)) {
      const dec: Decision = { uid, action: decisions.length % 2 === 0 ? 'skill' : 'attack' };
      decisions.push(dec);
      s = advance(s, dec).state;
    } else {
      s = advance(s, decider(s)).state;
    }
  }
  assert.equal(decisions.length, 102);

  // Warmup
  runBattle(setup, decisions.slice(0, 5), decider);

  // Incremental timing
  const incSamples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    let cur = runBattle(setup, [], decider).state;
    for (let k = 0; k < decisions.length; k++) {
      cur = stepBattle(cur, decisions[k]!, decider).state;
    }
    incSamples.push(performance.now() - t0);
  }
  incSamples.sort((a, b) => a - b);
  const incMedian = incSamples[2]!;

  // Repeat timing (old live UI style)
  const repeatSamples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    for (let k = 1; k <= decisions.length; k++) {
      runBattle(setup, decisions.slice(0, k), decider);
    }
    repeatSamples.push(performance.now() - t0);
  }
  repeatSamples.sort((a, b) => a - b);
  const repeatMedian = repeatSamples[1]!;

  // Verify incremental is substantially faster than repeat work
  assert.ok(incMedian < repeatMedian, `incremental median (${incMedian.toFixed(2)}ms) must be faster than repeat median (${repeatMedian.toFixed(2)}ms)`);
});
