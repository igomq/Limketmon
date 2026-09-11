import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ability, BattleEvent, BattleSetup, BattleState, CombatantSeed, Decision, Element, StatusId } from '../lib/battle/types.ts';
import { ENERGY_PER_TURN, ENERGY_START, MAX_ROUNDS, advance, createBattle, effectiveStat, livingOf } from '../lib/battle/engine.ts';
import { runBattle } from '../lib/battle/simulate.ts';
import { nextRandom, seedFrom } from '../lib/battle/rng.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function basicAbility(): Ability {
  return { id: 'basic', name: '타격', description: '', cost: 1, cooldown: 0, ops: [{ op: 'damage', power: 10 }] };
}

function unit(over: Partial<CombatantSeed> = {}): CombatantSeed {
  return {
    cardId: 'test-card',
    name: 'Test',
    rarity: 'N',
    element: 'light',
    maxHp: 100,
    atk: 20,
    def: 10,
    spd: 10,
    crit: 0,
    ability: basicAbility(),
    ...over
  };
}

function setup(over: Partial<BattleSetup> = {}): BattleSetup {
  return {
    kind: 'pve',
    opponentId: 'test-opponent',
    modifier: { kind: 'none' },
    seed: 1,
    player: [unit()],
    opponent: [unit()],
    ...over
  };
}

const brain = (state: BattleState): Decision => ({ uid: state.activeUid ?? '', action: 'attack' });

const attack = (uid: string): Decision => ({ uid, action: 'attack' });
type DamageEvent = Extract<BattleEvent, { t: 'damage' }>;
const damageEvents = (events: BattleEvent[]): DamageEvent[] => events.filter((event): event is DamageEvent => event.t === 'damage');

/** Stable projection used to compare whole battles. */
function project(state: BattleState): string {
  return JSON.stringify({
    status: state.status,
    endReason: state.endReason,
    round: state.round,
    rng: state.rng,
    rngDraws: state.rngDraws,
    activeUid: state.activeUid,
    sides: [state.sides.a, state.sides.b].map((side) =>
      side.map((c) => [c.uid, c.hp, c.energy, c.cooldown, c.statuses])
    ),
    damageBy: state.damageBy,
    log: state.log.length
  });
}

/** Plays the battle with a scripted player (basic attacks) and collects the player decisions. */
function script(setup: BattleSetup, pick: (state: BattleState, uid: string) => Decision = (_state, uid) => attack(uid)): Decision[] {
  let state = createBattle(setup);
  const player: Decision[] = [];
  for (let guard = 0; state.status === 'active' && guard < 500; guard += 1) {
    const uid = state.activeUid;
    assert.ok(uid !== null);
    const decision = pick(state, uid);
    const result = advance(state, decision);
    assert.equal(result.error, undefined);
    state = result.state;
    if (state.sides.a.some((combatant) => combatant.uid === uid)) player.push(decision);
  }
  return player;
}

const bulkyTeam = (spd: number[]): CombatantSeed[] =>
  spd.map((value, index) => unit({ cardId: `bulk-${index}`, maxHp: 10000, atk: 20, def: 10, spd: value, crit: 0 }));

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

test('rng: seedFrom normalises to a non-zero uint32 and nextRandom is reproducible', () => {
  assert.equal(seedFrom(0), seedFrom(0));
  assert.notEqual(seedFrom(0), 0);
  assert.equal(seedFrom(0x1_0000_0001), seedFrom(1), 'seeds are normalised modulo 2^32');
  assert.ok(seedFrom(-1) > 0);
  const left = { rng: seedFrom(99), rngDraws: 0 };
  const right = { rng: seedFrom(99), rngDraws: 0 };
  const leftValues = Array.from({ length: 8 }, () => nextRandom(left));
  const rightValues = Array.from({ length: 8 }, () => nextRandom(right));
  assert.deepEqual(leftValues, rightValues);
  assert.equal(left.rngDraws, 8);
  assert.ok(leftValues.every((value) => value >= 0 && value < 1));
  assert.ok(new Set(leftValues).size > 1);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('same seed and same decisions produce an identical battle', () => {
  const battle = setup({ seed: 4242, player: bulkyTeam([30, 20, 10]), opponent: bulkyTeam([5, 4, 3]) });
  const decisions: Decision[] = [];
  for (let round = 0; round < 40; round += 1) for (const uid of ['a0', 'a1', 'a2']) decisions.push(attack(uid));
  const first = runBattle(battle, decisions, brain);
  const second = runBattle(battle, decisions, brain);
  assert.equal(first.error, undefined);
  assert.deepEqual(decisions.slice(0, 3).map((decision) => decision.uid), ['a0', 'a1', 'a2']);
  assert.equal(project(first.state), project(second.state));
  assert.deepEqual(first.events, second.events);
  assert.equal(first.state.round, MAX_ROUNDS + 1);
  assert.equal(first.state.status, 'draw');
  assert.equal(first.state.endReason, 'timeout');
});

test('a different seed changes the damage sequence for the same decisions', () => {
  const team = () => ({ player: bulkyTeam([30, 20, 10]), opponent: bulkyTeam([5, 4, 3]) });
  const decisions: Decision[] = [];
  for (let round = 0; round < 40; round += 1) for (const uid of ['a0', 'a1', 'a2']) decisions.push(attack(uid));
  const one = runBattle(setup({ seed: 11, ...team() }), decisions, brain);
  const two = runBattle(setup({ seed: 12, ...team() }), decisions, brain);
  const amounts = (state: BattleState) => JSON.stringify(damageEvents(state.log).map((event) => event.amount));
  assert.notEqual(amounts(one.state), amounts(two.state));
});

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

test('round 1 queue orders by speed, then side, then slot', () => {
  const mixed = createBattle(
    setup({ player: [unit({ spd: 10 }), unit({ spd: 30 }), unit({ spd: 20 })], opponent: [unit({ spd: 25 }), unit({ spd: 5 }), unit({ spd: 15 })] })
  );
  assert.deepEqual(mixed.queue, ['a1', 'b0', 'a2', 'b2', 'a0', 'b1']);
  assert.equal(mixed.activeUid, 'a1');

  const tied = createBattle(setup({ player: [unit(), unit(), unit()], opponent: [unit(), unit(), unit()] }));
  assert.deepEqual(tied.queue, ['a0', 'a1', 'a2', 'b0', 'b1', 'b2']);

  const afterDown = advance(mixed, { uid: 'a1', action: 'attack' }).state;
  assert.equal(afterDown.activeUid, 'b0');
  assert.deepEqual(afterDown.queue, ['b0', 'a2', 'b2', 'a0', 'b1']);

  const battle = createBattle(setup());
  assert.equal(livingOf(battle, 'a').length, 1);
  assert.equal(livingOf(battle, 'b').length, 1);
  assert.equal(battle.sides.a[0].energy, ENERGY_START + ENERGY_PER_TURN, 'starts at 3 and gains its turn regen');
});

// ---------------------------------------------------------------------------
// Damage math
// ---------------------------------------------------------------------------

test('higher defense strictly reduces damage', () => {
  const hit = (def: number): number => {
    const state = createBattle(setup({ seed: 7, player: [unit({ atk: 100, crit: 0 })], opponent: [unit({ def })] }));
    const result = advance(state, attack('a0'));
    const damage = damageEvents(result.events)[0];
    assert.equal(damage.crit, false);
    assert.equal(damage.element, 'neutral');
    return damage.amount;
  };
  assert.ok(hit(80) < hit(10), `def 80 (${hit(80)}) should beat def 10 (${hit(10)})`);
});

test('element ring: advantage > neutral > disadvantage', () => {
  const hit = (defenderElement: Element, modifier: BattleSetup['modifier'] = { kind: 'none' }): number => {
    const state = createBattle(
      setup({ seed: 13, modifier, player: [unit({ element: 'water', atk: 50 })], opponent: [unit({ element: defenderElement, def: 10 })] })
    );
    return damageEvents(advance(state, attack('a0')).events)[0].amount;
  };
  // ring: water beats fire, is beaten by dark, and is neutral against grass/earth.
  assert.ok(hit('fire') > hit('grass'), 'strong must beat neutral');
  assert.ok(hit('grass') > hit('dark'), 'neutral must beat weak');

  const boosted = hit('fire', { kind: 'element_boost', element: 'water', bonus: 0.5 });
  assert.ok(boosted > hit('fire'), 'element_boost on a matching attacker must raise damage');
  const unboosted = hit('fire', { kind: 'element_boost', element: 'grass', bonus: 0.5 });
  assert.equal(unboosted, hit('fire'), 'element_boost on a non-matching attacker changes nothing');
});

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

test('poison ticks at the start of the bearer turn and expires after its duration', () => {
  const state = createBattle(setup({ seed: 3 }));
  state.sides.a[0].statuses.push({ id: 'poison' as StatusId, turns: 2, value: 7 });
  const first = advance(state, attack('a0'));
  const poisonIndex = first.events.findIndex((event) => event.t === 'damage' && event.source === 'poison');
  const attackIndex = first.events.findIndex((event) => event.t === 'damage' && event.source === 'attack');
  assert.ok(poisonIndex >= 0, 'poison must deal damage');
  assert.ok(poisonIndex < attackIndex, 'poison ticks before the action');
  const damages = damageEvents(first.events);
  assert.equal(damages[0].source, 'poison');
  assert.equal(damages[0].amount, 7);
  assert.equal(damages[1].source, 'attack');
  assert.equal(first.state.sides.a[0].hp, 100 - 7, 'the bearer only loses the poison tick');
  assert.equal(first.state.sides.b[0].hp, 100 - damages[1].amount, 'the attack still lands on the enemy');
  assert.equal(state.sides.a[0].hp, 100, 'advance must not mutate the input state');

  const second = advance(first.state, attack('b0'));
  const third = advance(second.state, attack('a0'));
  assert.equal(second.state.sides.a[0].statuses.filter((status) => status.id === 'poison').length, 1);
  assert.equal(third.state.sides.a[0].statuses.some((status) => status.id === 'poison'), false, 'poison expires');
});

test('stun skips exactly one turn', () => {
  const state = createBattle(setup({ seed: 5 }));
  state.sides.a[0].statuses.push({ id: 'stun' as StatusId, turns: 1, value: 1 });

  const skipped = advance(state, attack('a0'));
  assert.deepEqual(
    skipped.events.filter((event) => event.t === 'skip' || event.t === 'action' || event.t === 'damage'),
    [{ t: 'skip', uid: 'a0', reason: 'stun' }]
  );
  assert.equal(skipped.state.sides.a[0].statuses.some((status) => status.id === 'stun'), false);
  assert.equal(skipped.state.sides.a[0].hp, 100);
  assert.equal(skipped.state.sides.b[0].hp, 100, 'a stunned actor deals no damage');

  const opponent = advance(skipped.state, attack('b0'));
  const resumed = advance(opponent.state, attack('a0'));
  assert.equal(resumed.state.round, 2);
  assert.ok(resumed.events.some((event) => event.t === 'action' && event.uid === 'a0'), 'the next turn is normal');
  assert.ok(resumed.state.sides.b[0].hp < 100);
});

test('shield absorbs damage before hp', () => {
  const state = createBattle(setup({ seed: 17, player: [unit({ atk: 100 })], opponent: [unit({ def: 10 })] }));
  state.sides.b[0].statuses.push({ id: 'shield' as StatusId, turns: 2, value: 5 });
  const result = advance(state, attack('a0'));
  const damage = damageEvents(result.events)[0];
  assert.equal(damage.absorbed, 5);
  assert.ok(damage.amount > 5);
  assert.equal(result.state.sides.b[0].hp, 100 - (damage.amount - 5));
  assert.equal(result.state.sides.b[0].statuses.some((status) => status.id === 'shield'), false, 'a drained shield is removed');
});

// ---------------------------------------------------------------------------
// Cooldown and energy
// ---------------------------------------------------------------------------

test('cooldown gates the skill and recovers after the ticks', () => {
  const skill: Ability = { id: 'big', name: '큰 기술', description: '', cost: 0, cooldown: 2, ops: [{ op: 'damage', power: 10 }] };
  const state = createBattle(
    setup({ seed: 21, player: [unit({ atk: 1, maxHp: 10000, ability: skill })], opponent: [unit({ atk: 1, maxHp: 10000 })] })
  );

  const used = advance(state, { uid: 'a0', action: 'skill' });
  assert.equal(used.error, undefined);
  assert.ok(used.events.some((event) => event.t === 'action' && event.action === 'skill'));

  const other = advance(used.state, attack('b0'));
  const blocked = advance(other.state, { uid: 'a0', action: 'skill' });
  assert.equal(blocked.error, 'cooldown');
  assert.equal(blocked.state, other.state, 'a rejected decision returns the input state untouched');
  assert.deepEqual(blocked.events, []);

  const attacked = advance(other.state, attack('a0'));
  const other2 = advance(attacked.state, attack('b0'));
  const blockedAgain = advance(other2.state, { uid: 'a0', action: 'skill' });
  assert.equal(blockedAgain.error, 'cooldown');

  const attacked2 = advance(other2.state, attack('a0'));
  const other3 = advance(attacked2.state, attack('b0'));
  const ready = advance(other3.state, { uid: 'a0', action: 'skill' });
  assert.equal(ready.error, undefined, 'cooldown 2 blocks two rounds and then clears');
  assert.equal(ready.state.round, 4);
  assert.ok(ready.events.some((event) => event.t === 'action' && event.action === 'skill'));
});

test('skill is rejected when energy is below cost', () => {
  const skill: Ability = { id: 'costly', name: '고비용', description: '', cost: 9, cooldown: 0, ops: [{ op: 'damage', power: 10 }] };
  const state = createBattle(setup({ seed: 23, player: [unit({ ability: skill })] }));
  assert.equal(state.sides.a[0].energy, ENERGY_START + ENERGY_PER_TURN);
  const result = advance(state, { uid: 'a0', action: 'skill' });
  assert.equal(result.error, 'energy');
  assert.equal(result.state, state);
  assert.deepEqual(result.events, []);

  const basic = advance(state, attack('a0'));
  assert.equal(basic.error, undefined, 'basic attacks cost nothing');
});

test('illegal decisions are rejected without advancing', () => {
  const state = createBattle(setup());
  assert.equal(advance(state, attack('b0')).error, 'uid');
  assert.equal(advance(state, { uid: 'a0', action: 'wait' } as unknown as Decision).error, 'action');
  const ended = { ...structuredClone(state), status: 'won' as const };
  assert.equal(advance(ended, attack('a0')).error, 'ended');
});

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

test('multi-hit fires one hit per hit and clamps to 4', () => {
  const triple: Ability = { id: 'triple', name: '삼연격', description: '', cost: 0, cooldown: 0, ops: [{ op: 'damage', power: 5, hits: 3 }] };
  const state = createBattle(setup({ seed: 31, player: [unit({ ability: triple })], opponent: [unit({ maxHp: 500 })] }));
  const result = advance(state, { uid: 'a0', action: 'skill' });
  assert.equal(damageEvents(result.events).length, 3);
  assert.ok(result.state.rngDraws >= 6, 'every hit draws its own variance and crit');

  const wild: Ability = { id: 'wild', name: '난타', description: '', cost: 0, cooldown: 0, ops: [{ op: 'damage', power: 1, hits: 9 }] };
  const clamped = createBattle(setup({ seed: 31, player: [unit({ ability: wild })], opponent: [unit({ maxHp: 500 })] }));
  assert.equal(damageEvents(advance(clamped, { uid: 'a0', action: 'skill' }).events).length, 4);
});

test('conditional runs its then-branch only when the condition holds', () => {
  const conditional: Ability = {
    id: 'recover',
    name: '회복',
    description: '',
    cost: 0,
    cooldown: 0,
    ops: [{ op: 'conditional', when: { selfHpBelow: 90 }, then: [{ op: 'heal', amount: 20, target: 'self' }] }]
  };
  const hurt = createBattle(setup({ seed: 37, player: [unit({ ability: conditional })] }));
  hurt.sides.a[0].hp = 50;
  const healed = advance(hurt, { uid: 'a0', action: 'skill' });
  assert.ok(healed.events.some((event) => event.t === 'heal' && event.amount === 20));
  assert.equal(healed.state.sides.a[0].hp, 70);

  const late: Ability = { ...conditional, ops: [{ op: 'conditional', when: { turnAtLeast: 99 }, then: [{ op: 'heal', amount: 20, target: 'self' }] }] };
  const waiting = createBattle(setup({ seed: 37, player: [unit({ ability: late })] }));
  waiting.sides.a[0].hp = 50;
  const skipped = advance(waiting, { uid: 'a0', action: 'skill' });
  assert.equal(skipped.events.some((event) => event.t === 'heal'), false);
  assert.equal(skipped.state.sides.a[0].hp, 50);
});

test('shield and status ops apply to their targets, chance rolls included', () => {
  const support: Ability = {
    id: 'support',
    name: '지원',
    description: '',
    cost: 0,
    cooldown: 0,
    ops: [
      { op: 'shield', amount: 12, target: 'ally_lowest_hp' },
      { op: 'modify_stat', status: 'atk_up', turns: 3, value: 50, target: 'self' },
      { op: 'apply_status', status: 'stun', turns: 1, chance: 100, target: 'enemy_active' }
    ]
  };
  const state = createBattle(setup({ seed: 41, player: [unit({ ability: support }), unit({ spd: 1 })], opponent: [unit({ spd: 1 })] }));
  state.sides.a[1].hp = 40;
  const result = advance(state, { uid: 'a0', action: 'skill' });
  assert.ok(result.events.some((event) => event.t === 'shield' && event.target === 'a1' && event.amount === 12));
  assert.equal(effectiveStat(result.state.sides.a[0], 'atk'), 30);
  assert.ok(result.events.some((event) => event.t === 'status' && event.status === 'stun' && event.target === 'b0' && event.applied));
  assert.ok(result.state.sides.b[0].statuses.some((status) => status.id === 'stun'));
});

test('malformed ability warns and falls back to a basic attack', () => {
  const broken = { id: 'broken', name: '고장', description: '', cost: 1, cooldown: 0, ops: [{ op: 'explode', power: 999 }] } as unknown as Ability;
  const state = createBattle(setup({ seed: 43, player: [unit({ atk: 40, ability: broken })] }));
  const result = advance(state, { uid: 'a0', action: 'skill' });
  assert.equal(result.error, undefined);
  assert.ok(result.events.some((event) => event.t === 'warn'));
  assert.ok(result.events.some((event) => event.t === 'action' && event.action === 'attack'));
  assert.ok(result.state.sides.b[0].hp < 100);
  assert.equal(result.state.sides.a[0].energy, ENERGY_START + ENERGY_PER_TURN, 'the fallback attack is free');

  const noOps = { id: 'empty', name: '빈 기술', description: '', cost: 1, cooldown: 0, ops: [] } as unknown as Ability;
  const empty = createBattle(setup({ seed: 43, player: [unit({ ability: noOps })] }));
  assert.ok(advance(empty, { uid: 'a0', action: 'skill' }).events.some((event) => event.t === 'warn'));
});

// ---------------------------------------------------------------------------
// Battle end + runBattle
// ---------------------------------------------------------------------------

test('scripted battle ends with a matching end event', () => {
  const won = advance(createBattle(setup({ seed: 47, player: [unit({ atk: 100 })], opponent: [unit({ maxHp: 10 })] })), attack('a0'));
  assert.equal(won.state.status, 'won');
  assert.equal(won.state.endReason, 'hp');
  assert.deepEqual(won.events.at(-1), { t: 'end', status: 'won', round: 1, reason: 'hp' });
  assert.equal(won.state.activeUid, null);

  const losing = createBattle(setup({ seed: 47, player: [unit({ maxHp: 10 })], opponent: [unit({ atk: 100 })] }));
  const first = advance(losing, attack('a0'));
  const lost = advance(first.state, attack('b0'));
  assert.equal(lost.state.status, 'lost');
  assert.deepEqual(lost.events.at(-1), { t: 'end', status: 'lost', round: 1, reason: 'hp' });

  const draw = createBattle(setup({ seed: 47, player: [], opponent: [] }));
  assert.equal(draw.status, 'draw');
  assert.equal(draw.endReason, 'hp');
  assert.deepEqual(draw.log.at(-1), { t: 'end', status: 'draw', round: 1, reason: 'hp' });
});

test('turn_limit ends the battle as a loss when the player has not won', () => {
  const instant = createBattle(setup({ modifier: { kind: 'turn_limit', turns: 0 } }));
  assert.equal(instant.status, 'lost');
  assert.equal(instant.endReason, 'turn_limit');
  assert.deepEqual(instant.log.at(-1), { t: 'end', status: 'lost', round: 1, reason: 'turn_limit' });

  const limited = createBattle(
    setup({ modifier: { kind: 'turn_limit', turns: 1 }, player: [unit({ atk: 1, maxHp: 1000 })], opponent: [unit({ atk: 1, maxHp: 1000 })] })
  );
  const one = advance(limited, attack('a0'));
  const two = advance(one.state, attack('b0'));
  assert.equal(two.state.round, 2);
  assert.equal(two.state.status, 'lost');
  assert.equal(two.state.endReason, 'turn_limit');

  const winning = createBattle(
    setup({ modifier: { kind: 'turn_limit', turns: 1 }, player: [unit({ atk: 100 })], opponent: [unit({ maxHp: 10 })] })
  );
  assert.equal(advance(winning, attack('a0')).state.status, 'won', 'winning first beats the limit');
});

test('runBattle is reproducible and reports unfinished when player decisions run out', () => {
  const battle = setup({ seed: 53, player: [unit({ atk: 30 }), unit({ spd: 8, atk: 25 })], opponent: [unit({ maxHp: 60, atk: 25 }), unit({ spd: 7 })] });
  const decisions = script(battle);
  assert.ok(decisions.length > 0);

  const first = runBattle(battle, decisions, brain);
  const second = runBattle(battle, decisions, brain);
  assert.equal(first.error, undefined);
  assert.equal(first.state.status, 'won');
  assert.equal(project(first.state), project(second.state));
  assert.deepEqual(first.decisions, second.decisions);
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.events.at(-1), { t: 'end', status: 'won', round: first.state.round, reason: 'hp' });
  assert.equal(first.decisions.length, first.state.log.filter((event) => event.t === 'action').length);

  const short = runBattle(battle, decisions.slice(0, 1), brain);
  assert.equal(short.error, 'unfinished');

  const mismatched = runBattle(battle, [{ uid: 'a1', action: 'attack' }], brain);
  assert.equal(mismatched.error, 'uid');
});
