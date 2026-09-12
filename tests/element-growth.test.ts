// Element combat, member positions, owned-card traits, transcendence (XR), opponent tuning and
// snapshot replay. Pure contracts: every fixture is hand-built or comes from the curated manifest,
// so the file needs no server, database or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../lib/data/cards.curated.json' with { type: 'json' };
import type { Card } from '../lib/cards.ts';
import {
  BATTLE_RULESET_VERSION,
  ELEMENT_LABEL,
  ELEMENT_LINKS,
  ELEMENT_RING,
  ELEMENTS,
  POSITIONS,
  POSITION_LABEL,
  SYNERGY_BASE,
  SYNERGY_WINDOW_ROUNDS,
  elementLinkOf,
  positionOf,
  traitEffect,
  type Ability,
  type BattleEvent,
  type BattleSetup,
  type BattleState,
  type CombatantSeed,
  type Decision,
  type Element
} from '../lib/battle/types.ts';
import { RARITY_COST, battleStats, elementOf, rarityScale } from '../lib/battle/stats.ts';
import { enhancePower } from '../lib/enhance.ts';
import { abilityFor, validateAbility } from '../lib/battle/abilities.ts';
import { scaleAbility } from '../lib/battle/enhance-skills.ts';
import { buildSetup, combatantSeed, opponentTeam } from '../lib/battle/setup.ts';
import { OPPONENTS, opponentById } from '../lib/battle/opponents.ts';
import { advance, createBattle } from '../lib/battle/engine.ts';
import { MAX_TRAIT_LEVEL, effectiveCard, traitValue, type CardProgress, type Trait, type TraitId } from '../lib/progression.ts';
import { dailyChallenge } from '../lib/daily.ts';

const cards = manifest.cards as Card[];
const cardById = (id: string): Card => {
  const card = cards.find((entry) => entry.id === id);
  assert.ok(card, `unknown card ${id}`);
  return card;
};
/** HP + 2*ATK + DEF, the same normalized power unit the stat derivation aims at. */
const power = (stats: { maxHp: number; atk: number; def: number }) => stats.maxHp + stats.atk * 2 + stats.def;

function trait(id: TraitId, level: number, transcended = false): Trait {
  return { id, level, transcended };
}

function ability(over: Partial<Ability> = {}): Ability {
  return { id: 'basic', name: '타격', description: '', cost: 0, cooldown: 0, ops: [{ op: 'damage', power: 10 }], ...over };
}

function unit(over: Partial<CombatantSeed> = {}): CombatantSeed {
  return {
    cardId: 'test-card',
    name: 'Test',
    rarity: 'N',
    element: 'earth',
    maxHp: 100,
    atk: 20,
    def: 10,
    spd: 10,
    crit: 0,
    ability: ability(),
    ...over
  };
}

function setup(over: Partial<BattleSetup> = {}): BattleSetup {
  return { kind: 'pve', opponentId: 'test-opponent', modifier: { kind: 'none' }, seed: 7, player: [unit()], opponent: [unit()], ...over };
}

const attack = (uid: string): Decision => ({ uid, action: 'attack' });

type DamageEvent = Extract<BattleEvent, { t: 'damage' }>;
const damageEvents = (events: BattleEvent[]): DamageEvent[] => events.filter((event): event is DamageEvent => event.t === 'damage');

/** Deterministic scripted battle: every actor attacks, in queue order. */
function play(setupInput: BattleSetup, maxTurns = 200): { state: BattleState; events: BattleEvent[] } {
  let state = createBattle(setupInput);
  const events: BattleEvent[] = [];
  for (let turn = 0; turn < maxTurns && state.status === 'active'; turn += 1) {
    const uid = state.activeUid;
    assert.ok(uid, 'battle lost its active uid');
    const result = advance(state, attack(uid));
    assert.equal(result.error, undefined, result.error);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

/** Stable projection used to prove a replay is byte-identical, marks and traits included. */
function project(state: BattleState): string {
  return JSON.stringify({
    status: state.status,
    endReason: state.endReason,
    round: state.round,
    rng: state.rng,
    rngDraws: state.rngDraws,
    activeUid: state.activeUid,
    damageBy: state.damageBy,
    sides: [state.sides.a, state.sides.b].map((side) =>
      side.map((c) => [c.uid, c.hp, c.energy, c.cooldown, c.mark, c.traits, c.statuses])
    )
  });
}

/** One hit of a lone attacker against a punching-bag defender, with a fixed seed. */
function hit(attacker: Partial<CombatantSeed>, defender: Partial<CombatantSeed>, seed = 5): DamageEvent {
  const battle = setup({
    seed,
    player: [unit({ element: 'earth', atk: 50, crit: 0, ...attacker })],
    opponent: [unit({ element: 'earth', def: 0, spd: 1, maxHp: 100000, ...defender })]
  });
  const state = createBattle(battle);
  const result = advance(state, attack('a0'));
  assert.equal(result.error, undefined, result.error);
  const damage = damageEvents(result.events)[0];
  assert.ok(damage, 'no damage event');
  return damage;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

test('elements: the five ids, Korean labels and the water > fire > grass > earth > dark ring', () => {
  assert.deepEqual([...ELEMENTS], ['earth', 'water', 'fire', 'grass', 'dark']);
  assert.deepEqual([...ELEMENT_RING], ['water', 'fire', 'grass', 'earth', 'dark']);
  assert.equal(new Set(ELEMENTS).size, 5);
  for (const element of ELEMENTS) assert.match(ELEMENT_LABEL[element], /\S/);
  assert.deepEqual(
    ELEMENTS.map((element) => ELEMENT_LABEL[element]),
    ['대지', '물', '불', '풀', '암흑']
  );
});

test('elements: catalog coverage stays broad enough for cheap decks', () => {
  const counts = new Map<Element, number>();
  for (const card of cards) {
    const element = elementOf(card);
    assert.ok(ELEMENTS.includes(element), card.id);
    assert.equal(element, elementOf(card), card.id);
    counts.set(element, (counts.get(element) ?? 0) + 1);
  }
  for (const element of ELEMENTS) assert.ok((counts.get(element) ?? 0) > 0, `no card is ${element}`);
  const cheap = cards.filter((card) => card.rarity === 'N' || card.rarity === 'R');
  assert.ok(new Set(cheap.map(elementOf)).size >= 3, 'cheap decks must cover several elements');
});

test('elements: ring advantage is 1.25x, disadvantage 0.8x, everything else neutral', () => {
  const strong = hit({ element: 'water' }, { element: 'fire' });
  const weak = hit({ element: 'fire' }, { element: 'water' });
  const neutral = hit({ element: 'fire' }, { element: 'fire' });
  assert.equal(strong.element, 'strong');
  assert.equal(weak.element, 'weak');
  assert.equal(neutral.element, 'neutral');
  // Same seed, same draws: only the ring multiplier differs.
  assert.ok(strong.amount > neutral.amount, `${strong.amount} vs ${neutral.amount}`);
  assert.ok(neutral.amount > weak.amount, `${neutral.amount} vs ${weak.amount}`);
  assert.ok(Math.abs(strong.amount / neutral.amount - 1.25) < 0.06);
  assert.ok(Math.abs(weak.amount / neutral.amount - 0.8) < 0.06);
});

// ---------------------------------------------------------------------------
// Element link (연계)
// ---------------------------------------------------------------------------

test('links: every element is both a mark and a follow-up, with the named Korean pairs', () => {
  assert.equal(SYNERGY_BASE, 1.3);
  assert.equal(SYNERGY_WINDOW_ROUNDS, 2);
  assert.deepEqual(
    ELEMENT_LINKS.map((link) => `${link.from}>${link.to}:${link.name}`),
    ['fire>water:증발', 'water>grass:개화', 'grass>fire:연소', 'earth>dark:침식', 'dark>earth:붕괴']
  );
  assert.deepEqual([...ELEMENT_LINKS.map((link) => link.from)].sort(), [...ELEMENTS].sort());
  assert.deepEqual([...ELEMENT_LINKS.map((link) => link.to)].sort(), [...ELEMENTS].sort());
  for (const link of ELEMENT_LINKS) {
    assert.equal(elementLinkOf(link.from, link.to)?.name, link.name);
    // A link never points at itself (the earth <-> dark pair is deliberately two named links).
    assert.equal(elementLinkOf(link.from, link.from), undefined);
  }
});

/** Two allies: the first marks the target with `markElement`, the second follows up with water. */
function followUp(markElement: Element, followTraits: Trait[] = [], seed = 11) {
  const battle = setup({
    seed,
    player: [
      unit({ cardId: 'a0', element: markElement, atk: 20 }),
      unit({ cardId: 'a1', element: 'water', atk: 20, traits: followTraits })
    ],
    opponent: [unit({ cardId: 'b0', element: 'grass', maxHp: 100000, atk: 1, def: 0, spd: 1 })]
  });
  let state = createBattle(battle);
  state = advance(state, attack('a0')).state;
  const result = advance(state, attack('a1'));
  assert.equal(result.error, undefined, result.error);
  const damage = damageEvents(result.events).find((event) => event.uid === 'a1');
  assert.ok(damage, 'no follow-up damage event');
  return { damage, state: result.state, events: result.events };
}

test('links: a fire mark cashed by water deals 1.3x and is reported in the log', () => {
  const linked = followUp('fire');
  const control = followUp('grass');
  assert.equal(linked.damage.synergy?.name, '증발');
  assert.ok(Math.abs((linked.damage.synergy?.multiplier ?? 0) - 1.3) < 1e-9);
  assert.equal(control.damage.synergy, undefined);
  assert.ok(linked.damage.amount > control.damage.amount);
  assert.ok(Math.abs(linked.damage.amount / control.damage.amount - 1.3) < 0.08, `${linked.damage.amount} vs ${control.damage.amount}`);
});

test('links: the mark is consumed, so one multi-hit cannot fire the link twice', () => {
  const multi: Ability = { id: 'multi', name: '연타', description: '', cost: 0, cooldown: 0, ops: [{ op: 'damage', power: 10, hits: 2, target: 'enemy_active' }] };
  const battle = setup({
    seed: 21,
    player: [
      unit({ cardId: 'a0', element: 'fire', atk: 20 }),
      unit({ cardId: 'a1', element: 'water', atk: 20, skills: [multi] })
    ],
    opponent: [unit({ cardId: 'b0', element: 'grass', maxHp: 100000, atk: 1, def: 0, spd: 1 })]
  });
  let state = createBattle(battle);
  state = advance(state, attack('a0')).state;
  const result = advance(state, { uid: 'a1', action: 'skill', skillId: 'multi' });
  assert.equal(result.error, undefined, result.error);
  const hits = damageEvents(result.events).filter((event) => event.uid === 'a1');
  assert.equal(hits.length, 2);
  assert.equal(hits.filter((event) => event.synergy).length, 1, 'the second hit of the multi must not re-fire the link');
  const target = result.state.sides.b[0]!;
  assert.equal(target.mark, null, 'the rest of the action must not refresh a consumed mark');
});

test('links: the mark only pays off within two rounds', () => {
  const battle = setup({
    seed: 31,
    player: [unit({ cardId: 'a0', element: 'fire', atk: 20 }), unit({ cardId: 'a1', element: 'water', atk: 20 })],
    opponent: [unit({ cardId: 'b0', element: 'grass', maxHp: 100000, atk: 1, def: 0, spd: 1 })]
  });
  const marked = advance(createBattle(battle), attack('a0')).state;
  assert.deepEqual(marked.sides.b[0]!.mark, { element: 'fire', round: marked.round });

  const inWindow = structuredClone(marked);
  inWindow.sides.b[0]!.mark = { element: 'fire', round: inWindow.round - SYNERGY_WINDOW_ROUNDS };
  const fresh = advance(inWindow, attack('a1'));
  assert.equal(damageEvents(fresh.events)[0]!.synergy?.name, '증발');

  const stale = structuredClone(marked);
  stale.sides.b[0]!.mark = { element: 'fire', round: stale.round - SYNERGY_WINDOW_ROUNDS - 1 };
  const expired = advance(stale, attack('a1'));
  assert.equal(damageEvents(expired.events)[0]!.synergy, undefined);
});

test('links: a same-element follow-up never links, and poison neither marks nor links', () => {
  const repeat = setup({
    seed: 41,
    player: [unit({ cardId: 'a0', element: 'fire', atk: 20 }), unit({ cardId: 'a1', element: 'fire', atk: 20 })],
    opponent: [unit({ cardId: 'b0', element: 'grass', maxHp: 100000, atk: 1, def: 0, spd: 1 })]
  });
  let state = advance(createBattle(repeat), attack('a0')).state;
  const second = advance(state, attack('a1'));
  assert.equal(damageEvents(second.events)[0]!.synergy, undefined);

  const poison: Ability = { id: 'venom', name: '독', description: '', cost: 0, cooldown: 0, ops: [{ op: 'apply_status', status: 'poison', turns: 3, value: 5, target: 'enemy_active' }] };
  const fight = setup({
    seed: 43,
    player: [unit({ cardId: 'a0', element: 'dark', ability: poison })],
    opponent: [unit({ cardId: 'b0', element: 'grass', maxHp: 100000, atk: 1, def: 0, spd: 1 })]
  });
  state = createBattle(fight);
  state = advance(state, { uid: 'a0', action: 'skill' }).state;
  assert.equal(state.sides.b[0]!.mark, null);
  const tick = advance(state, attack('b0'));
  const ticks = damageEvents(tick.events).filter((event) => event.target === 'b0');
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0]!.source, 'poison');
  assert.equal(ticks[0]!.synergy, undefined);
  assert.equal(tick.state.sides.b[0]!.mark, null, 'poison must not leave a mark');
});

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

test('traits: value is level*1% + 5% per 5 levels, doubled down on at 20, x2 when transcended', () => {
  assert.equal(MAX_TRAIT_LEVEL, 20);
  assert.equal(traitValue(trait('damage', 4)), 0.04);
  assert.equal(traitValue(trait('damage', 5)), 0.1);
  assert.equal(traitValue(trait('damage', 19)), 0.34);
  assert.ok(Math.abs(traitValue(trait('damage', 20)) - 0.4) < 1e-9);
  assert.ok(Math.abs(traitValue(trait('damage', 20, true)) - 0.8) < 1e-9);
  assert.equal(traitValue(trait('damage', 0)), 0);
});

test('traits: a damage trait grows the card own hits by its value', () => {
  const plain = hit({}, {}, 51);
  const boosted = hit({ traits: [trait('damage', 20)] }, {}, 51);
  assert.ok(Math.abs(boosted.amount / plain.amount - 1.4) < 0.02, `${boosted.amount} vs ${plain.amount}`);
});

test('traits: resist cuts only its own element and caps at 70%', () => {
  const plain = hit({ element: 'fire' }, {}, 61);
  const resisted = hit({ element: 'fire' }, { traits: [trait('resist_fire', 20)] }, 61);
  const other = hit({ element: 'fire' }, { traits: [trait('resist_water', 20)] }, 61);
  const capped = hit({ element: 'fire' }, { traits: [trait('resist_fire', 20, true)] }, 61);
  assert.ok(Math.abs(resisted.amount / plain.amount - 0.6) < 0.02);
  assert.equal(other.amount, plain.amount);
  // 0.4 x 2 = 0.80, then resist caps at 70%: the hit keeps 30%.
  assert.ok(Math.abs(capped.amount / plain.amount - 0.3) < 0.02, `${capped.amount} vs ${plain.amount}`);
});

test('traits: a synergy trait grows the link multiplier above 1.30', () => {
  const linked = followUp('fire', [trait('synergy', 20)]);
  assert.ok(Math.abs((linked.damage.synergy?.multiplier ?? 0) - 1.7) < 1e-9);
  const bare = followUp('fire');
  assert.ok(linked.damage.amount > bare.damage.amount);
});

test('traits: owned rows reach the seed, and an out-of-range level is clamped by the effect', () => {
  const seed = combatantSeed('imsingyu-v004', 1, 0, {
    baseCardId: 'imsingyu-v004',
    rarity: 'R',
    enhanceLevel: 0,
    traits: [trait('damage', 999), trait('synergy', -4), trait('resist_fire', 5)]
  });
  assert.equal(seed.rarity, 'R');
  assert.equal(seed.traits?.length, 3);
  // traitValue clamps to 0..20, so a forged row can never buy more than a maxed trait.
  assert.equal(traitEffect(seed.traits, 'damage'), traitValue(trait('damage', 20)));
  assert.equal(traitEffect(seed.traits, 'synergy'), traitValue(trait('synergy', 0)));
  assert.equal(traitEffect(seed.traits, 'resist_grass'), 0);
  assert.deepEqual(combatantSeed('imsingyu-v004').traits, []);
  assert.deepEqual(combatantSeed('imsingyu-v004', 1, 0, { baseCardId: 'imsingyu-v004', rarity: 'R', enhanceLevel: 0, traits: [] }).traits, []);
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

test('positions: ops decide the role, Korean labels match, all four roles exist', () => {
  assert.deepEqual([...POSITIONS], ['healer', 'tank', 'dealer', 'support']);
  assert.deepEqual(POSITIONS.map((position) => POSITION_LABEL[position]), ['힐러', '탱커', '딜러', '지원']);
  assert.equal(positionOf(ability()), 'dealer');
  assert.equal(positionOf(ability({ ops: [{ op: 'heal', amount: 5 }] })), 'healer');
  assert.equal(positionOf(ability({ ops: [{ op: 'shield', amount: 5 }] })), 'tank');
  assert.equal(positionOf(ability({ ops: [{ op: 'apply_status', status: 'stun', turns: 1 }] })), 'support');
  // 회복 wins over 보호, 보호 over 상태이상, 상태이상 over 공격.
  assert.equal(positionOf(ability({ ops: [
    { op: 'damage', power: 5 },
    { op: 'conditional', when: { selfHpBelow: 40 }, then: [{ op: 'heal', amount: 3 }, { op: 'shield', amount: 3 }] }
  ] })), 'healer');
  assert.equal(positionOf(ability({ ops: [{ op: 'shield', amount: 3 }, { op: 'apply_status', status: 'stun', turns: 1 }] })), 'tank');

  const seen = new Set<string>();
  for (const card of cards) {
    const base = battleStats(card);
    const signature = scaleAbility(base.ability, card.rarity, 0);
    const seed = combatantSeed(card.id);
    assert.ok(seed.position, card.id);
    seen.add(seed.position);
    assert.equal(seed.position, positionOf(signature), card.id);
    // The role bonus is the only difference, and healer/tank share the HP/DEF branch.
    assert.deepEqual(seed.ability, signature, card.id);
    switch (seed.position) {
      case 'healer':
      case 'tank':
        assert.equal(seed.maxHp, Math.max(1, Math.round(base.maxHp * 1.1)), card.id);
        assert.equal(seed.def, Math.max(1, Math.round(base.def * 1.1)), card.id);
        assert.equal(seed.atk, base.atk, card.id);
        assert.equal(seed.spd, base.spd, card.id);
        break;
      case 'dealer':
        assert.equal(seed.atk, Math.max(1, Math.round(base.atk * 1.05)), card.id);
        assert.equal(seed.def, base.def, card.id);
        break;
      case 'support':
        assert.equal(seed.spd, base.spd + 2, card.id);
        assert.equal(seed.atk, base.atk, card.id);
        break;
    }
  }
  assert.deepEqual([...seen].sort(), [...POSITIONS].sort());
});

test('positions: opponents carry them too, and the bonus applies on both sides', () => {
  for (const opponent of OPPONENTS) {
    for (const seed of opponentTeam(opponent.id, 'normal')) {
      assert.ok(seed.position !== undefined && POSITIONS.includes(seed.position), `${opponent.id} ${seed.cardId}`);
      assert.equal(seed.traits?.length ?? 0, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// Transcendence (XR)
// ---------------------------------------------------------------------------

test('promoted cards keep original shape and rise exactly once', () => {
  const n = cardById('imsingyu-v002');
  const native = battleStats(n);
  const promoted = battleStats(effectiveCard(n, 'owned-n-r', 'R'));
  const once = enhancePower('R', 0) / enhancePower('N', 0);
  const doubled = once * (rarityScale('R') / rarityScale('N'));
  const atkRatio = promoted.atk / native.atk;
  assert.ok(Math.abs(atkRatio - once) < 0.08, `atk ${atkRatio} vs once ${once}`);
  assert.ok(Math.abs(atkRatio - doubled) > 0.05, `atk ${atkRatio} must not match the squared scale ${doubled}`);
  const ur = cardById('imsingyu-v033');
  const xr = battleStats(effectiveCard(ur, 'owned-xr-shape', 'XR'));
  const urStats = battleStats(ur);
  assert.ok(Math.abs(xr.atk / urStats.atk - 1.45) < 0.08, `UR->XR atk ${xr.atk / urStats.atk}`);
});

test('XR: transcends exactly 1.45x its UR form without inventing a catalog band', () => {
  // XR has no catalog mean: it shares the UR normalization scale, because effectiveCard already
  // scales the promoted row's raw stats by the power-curve ratio. Scaling here again would square
  // it and hand a transcended card ~2.1x instead of 1.45x.
  assert.equal(rarityScale('XR'), rarityScale('UR'));
  assert.equal(RARITY_COST.XR, RARITY_COST.UR + 1);

  const ur = cardById('imsingyu-v033');
  const xr = effectiveCard(ur, 'owned-xr-1', 'XR');
  assert.equal(xr.rarity, 'XR');
  assert.equal(xr.id, 'owned-xr-1');
  assert.equal(xr.attack, Math.max(1, Math.round(ur.attack * 1.45)));
  assert.equal(xr.defense, Math.max(1, Math.round(ur.defense * 1.45)));
  const urStats = battleStats(ur);
  const xrStats = battleStats(xr);
  assert.ok(power(xrStats) > power(urStats), `${power(xrStats)} vs ${power(urStats)}`);
  // Slightly under 1.45 because the flat HP base in the stat derivation does not scale.
  assert.ok(Math.abs(power(xrStats) / power(urStats) - 1.45) < 0.08, `${power(xrStats)} vs ${power(urStats)}`);
  const xrAbility = abilityFor(xr);
  assert.equal(validateAbility(xrAbility).ok, true);
  assert.equal(xrAbility.cost, RARITY_COST.XR);
});

test('promoted UUIDs keep catalog ability, element and every unlocked skill', () => {
  for (const card of cards) {
    const native = combatantSeed(card.id, 1, 15);
    const promoted = combatantSeed(`owned-${card.id}`, 1, 15, {
      baseCardId: card.id, rarity: 'XR', enhanceLevel: 15, traits: []
    });
    assert.equal(promoted.ability.id, native.ability.id);
    assert.deepEqual(abilityFor(effectiveCard(card, `owned-${card.id}`, 'XR')).ops, abilityFor(card).ops);
    assert.equal(promoted.element, native.element);
    assert.equal(promoted.position, native.position);
    assert.ok(native.skills!.length > 0);
    assert.deepEqual(promoted.skills!.map((skill) => skill.id), native.skills!.map((skill) => skill.id));
  }
});

test('XR: owned progress drives the seed and keeps enhancement and traits', () => {
  const progress: CardProgress = {
    baseCardId: 'imsingyu-v033',
    rarity: 'XR',
    enhanceLevel: 5,
    traits: [trait('damage', 20), trait('resist_dark', 5)]
  };
  const seed = combatantSeed('owned-xr-1', 1, 0, progress);
  assert.equal(seed.cardId, 'owned-xr-1');
  assert.equal(seed.rarity, 'XR');
  assert.equal(seed.enhance, 5);
  assert.deepEqual(seed.traits, progress.traits);
  assert.ok(power(seed) > power(combatantSeed('imsingyu-v033')), 'a transcended row must beat the UR form');
  // Same card, same enhancement numbers: only the effective rarity band changed.
  const urSeed = combatantSeed('owned-plain', 1, 5, { baseCardId: 'imsingyu-v033', rarity: 'UR', enhanceLevel: 5, traits: [] });
  assert.ok(seed.atk > urSeed.atk && seed.maxHp > urSeed.maxHp);
  const xrHit = seed.ability.ops[1]!;
  const urHit = urSeed.ability.ops[1]!;
  assert.equal(xrHit.op, 'damage');
  assert.equal(urHit.op, 'damage');
  if (xrHit.op === 'damage' && urHit.op === 'damage') {
    assert.ok(Math.abs(xrHit.power / urHit.power - 1.45) < 0.03, 'signature grows once with XR power');
  }
});

// ---------------------------------------------------------------------------
// Difficulty tuning
// ---------------------------------------------------------------------------

test('opponents: ace and boss scale up, hard boss is pulled back, chaos general stages rise more', () => {
  assert.ok(Math.abs(opponentById('veteran', 'normal')!.statScale! - 1.06) < 1e-9);
  assert.ok(Math.abs(opponentById('ace', 'normal')!.statScale! - 1.06 * 1.18) < 1e-9);
  assert.ok(Math.abs(opponentById('boss', 'normal')!.statScale! - 1.06 * 1.2) < 1e-9);
  assert.ok(Math.abs(opponentById('ace', 'normal')!.hpScale - 1.15 * 1.18) < 1e-9);
  for (const id of ['rookie', 'regular', 'veteran', 'ace']) {
    assert.ok(Math.abs(opponentById(id, 'hard')!.statScale! - 1.52 * 1.15) < 1e-9, id);
  }
  assert.ok(Math.abs(opponentById('boss', 'hard')!.statScale! - 1.52 * 0.92) < 1e-9);
  // Hard is still harder than normal overall, but the boss is pulled back relative to hard's ace.
  assert.ok(opponentById('boss', 'hard')!.statScale! < opponentById('ace', 'hard')!.statScale!);
  assert.ok(opponentById('boss', 'hard')!.statScale! > opponentById('boss', 'normal')!.statScale!);
  assert.ok(Math.abs(opponentById('boss', 'hard')!.hpScale - 1.25 * 1.52 * 0.92) < 1e-9);
  assert.ok(Math.abs(opponentById('rookie', 'chaos')!.statScale! - 1.88 * 1.04) < 1e-9);
  assert.ok(Math.abs(opponentById('boss', 'chaos')!.statScale! - 1.88 * 1.02) < 1e-9);
  assert.ok(opponentById('rookie', 'chaos')!.statScale! > opponentById('boss', 'chaos')!.statScale!);
});

test('opponents: the scaled team is derived from the same cards the ladder names', () => {
  const ace = opponentById('ace', 'normal')!;
  const team = opponentTeam('ace', 'normal');
  team.forEach((seed, index) => {
    const cardId = ace.cards[index]!;
    assert.equal(seed.cardId, cardId);
    assert.equal(seed.atk, Math.max(1, Math.round(combatantSeed(cardId).atk * ace.statScale!)));
    assert.equal(seed.maxHp, combatantSeed(cardId, ace.hpScale).maxHp);
  });
});

// ---------------------------------------------------------------------------
// Snapshot replay
// ---------------------------------------------------------------------------

test('replay: the same setup and decisions reproduce a battle byte for byte', () => {
  const progress: CardProgress[] = [
    { baseCardId: 'imsingyu-v033', rarity: 'UR', enhanceLevel: 3, traits: [trait('damage', 10)] },
    { baseCardId: 'imsingyu-v004', rarity: 'R', enhanceLevel: 7, traits: [trait('resist_fire', 12)] },
    { baseCardId: 'imsingyu-v019', rarity: 'N', enhanceLevel: 0, traits: [] }
  ];
  const options = {
    kind: 'pve' as const,
    opponentId: 'veteran',
    modifier: { kind: 'none' as const },
    seed: 4242,
    playerCardIds: ['imsingyu-v033', 'imsingyu-v004', 'imsingyu-v019'],
    playerEnhance: [3, 7, 0],
    playerProgress: progress,
    mode: 'normal' as const
  };
  const built = buildSetup(options);
  assert.deepEqual(built.player.map((seed) => seed.cardId), options.playerCardIds);
  assert.deepEqual(built.player[0]!.traits, progress[0]!.traits);
  assert.deepEqual(buildSetup(options), built);
  assert.notDeepEqual(buildSetup({ ...options, playerProgress: undefined }), built);

  const first = play(built);
  const second = play(buildSetup(options));
  assert.equal(project(first.state), project(second.state));
  assert.deepEqual(first.events, second.events);

  // The wire form is JSON: a snapshot that made the round trip must replay identically.
  const snapshot = JSON.parse(JSON.stringify(built)) as BattleSetup;
  const replayed = play(snapshot);
  assert.equal(project(replayed.state), project(first.state));
  assert.deepEqual(replayed.events, first.events);
  assert.equal(replayed.state.ruleset, BATTLE_RULESET_VERSION);
  assert.equal(BATTLE_RULESET_VERSION, 7);
});

// ---------------------------------------------------------------------------
// Daily rotation
// ---------------------------------------------------------------------------

test('daily: the element boost rule only ever names the five live elements', () => {
  const boosted = new Set<Element>();
  for (let day = 1; day <= 20; day += 1) {
    const challenge = dailyChallenge(`2026-09-${String(day).padStart(2, '0')}`);
    if (challenge.modifier.kind !== 'element_boost') continue;
    boosted.add(challenge.modifier.element);
    assert.ok(ELEMENTS.includes(challenge.modifier.element));
    assert.match(challenge.title, /속성 강화$/);
    assert.ok(challenge.description.includes(ELEMENT_LABEL[challenge.modifier.element]));
  }
  assert.ok(boosted.size >= 3, `only ${boosted.size} elements were boosted in 20 days`);
});
