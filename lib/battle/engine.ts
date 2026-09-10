// Deterministic, pure, headless 3v3 turn-based battle engine.
//
// Purity: advance() deep-clones the incoming state, resolves one turn on the
// clone, and returns the clone plus the events produced by that single step.
// The clone's log carries the full history.
//
// Randomness: every draw comes from rng.ts and lands in state.rng / state.rngDraws.
// Draw order per damage hit is fixed: (1) variance, (2) crit. Status ops draw only
// when they carry a "chance". Nothing else draws, so a replay never desyncs.
//
// Damage formula (one hit):
//   attackValue = basic attack ? effectiveStat(attacker,'atk') : op.power
//   boost       = element_boost modifier matches attacker element ? 1 + bonus : 1
//   base        = max(1, attackValue * boost - effectiveStat(defender,'def') * 0.45)
//   variance    = 0.9 + draw1 * 0.2
//   element     = ring x1.25 (beats) / x0.8 (beaten by) / x1.0
//   crit        = draw2 * 100 < attacker.crit ? x1.6 : x1.0
//   final       = max(1, round(base * variance * element * crit))
// Shield absorbs first; the damage event reports the pre-shield amount plus the
// absorbed slice. Poison ticks and regen are flat and bypass the shield.

import type {
  Ability,
  AbilityCondition,
  AbilityOp,
  AbilityTarget,
  AdvanceResult,
  BattleEvent,
  BattleSetup,
  BattleState,
  Combatant,
  CombatantSeed,
  Decision,
  Element,
  Side,
  StatusId
} from './types.ts';
import { BATTLE_RULESET_VERSION, ELEMENT_RING, STATUS_IDS } from './types.ts';
import { nextRandom, seedFrom } from './rng.ts';

/** Hard ceiling on rounds; round > MAX_ROUNDS ends the battle as a timeout draw. */
export const MAX_ROUNDS = 40;

export const ENERGY_START = 3;
/** 1 per turn: at +2 a 2-cost N skill fired every single turn and stalemated the beginner bracket. */
export const ENERGY_PER_TURN = 1;
const ENERGY_MAX = 10;
const MAX_HITS = 4;
const MAX_OP_DEPTH = 4;
const CRIT_MULT = 1.6;
const RING_STRONG = 1.25;
const RING_WEAK = 0.8;
const DEF_FACTOR = 0.45;
/** The DSL's shield op has no duration field; it covers the bearer's next two turns. */
const SHIELD_TURNS = 2;

const STAT_STATUS_IDS: StatusId[] = ['atk_up', 'atk_down', 'def_up', 'def_down'];
const TARGETS = ['enemy_active', 'enemy_lowest_hp', 'enemy_all', 'self', 'ally_lowest_hp', 'ally_all'];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createBattle(setup: BattleSetup): BattleState {
  const state: BattleState = {
    ruleset: BATTLE_RULESET_VERSION,
    battleId: setup.battleId,
    kind: setup.kind,
    opponentId: setup.opponentId,
    modifier: { ...setup.modifier },
    seed: setup.seed >>> 0,
    rng: seedFrom(setup.seed),
    rngDraws: 0,
    round: 1,
    queue: [],
    activeUid: null,
    sides: {
      a: setup.player.map((seed, slot) => makeCombatant('a', slot, seed)),
      b: setup.opponent.map((seed, slot) => makeCombatant('b', slot, seed))
    },
    status: 'active',
    damageBy: {},
    log: []
  };
  for (const combatant of [...state.sides.a, ...state.sides.b]) state.damageBy[combatant.uid] = 0;

  const events = state.log;
  events.push({ t: 'start', round: 1 });
  state.queue = buildQueue(state);
  if (state.queue.length === 0) {
    endBattle(state, 'draw', 'hp', events);
    return state;
  }
  state.activeUid = state.queue[0];
  grantTurnEnergy(state, state.activeUid);
  if (state.modifier.kind === 'turn_limit' && state.round > state.modifier.turns) {
    endBattle(state, 'lost', 'turn_limit', events);
  }
  return state;
}

/** Shallow-copies the ability so a caller can never mutate the setup through the state. */
function makeCombatant(side: Side, slot: number, seed: CombatantSeed): Combatant {
  return {
    uid: `${side}${slot}`,
    side,
    slot,
    cardId: seed.cardId,
    name: seed.name,
    rarity: seed.rarity,
    element: seed.element,
    maxHp: seed.maxHp,
    hp: seed.maxHp,
    atk: seed.atk,
    def: seed.def,
    spd: seed.spd,
    crit: seed.crit,
    energy: ENERGY_START,
    cooldown: 0,
    ability: { ...seed.ability },
    statuses: []
  };
}

export function cloneState(state: BattleState): BattleState {
  return structuredClone(state);
}

export function livingOf(state: BattleState, side: Side): Combatant[] {
  return state.sides[side].filter((combatant) => combatant.hp > 0);
}

export function effectiveStat(combatant: Combatant, stat: 'atk' | 'def' | 'spd'): number {
  const base = combatant[stat];
  let percent = 0;
  for (const status of combatant.statuses) {
    if (stat === 'atk') {
      if (status.id === 'atk_up') percent += status.value;
      else if (status.id === 'atk_down') percent -= status.value;
    } else if (stat === 'def') {
      if (status.id === 'def_up') percent += status.value;
      else if (status.id === 'def_down') percent -= status.value;
    }
  }
  return Math.max(0, base * (1 + percent / 100));
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

export function advance(state: BattleState, decision: Decision): AdvanceResult {
  if (state.status !== 'active') return { state, events: [], error: 'ended' };
  const activeUid = state.activeUid;
  if (!activeUid || decision.uid !== activeUid) return { state, events: [], error: 'uid' };
  if (decision.action !== 'attack' && decision.action !== 'skill') return { state, events: [], error: 'action' };

  const next = cloneState(state);
  const actor = findCombatant(next, activeUid);
  if (!actor) return { state, events: [], error: 'uid' };

  const events: BattleEvent[] = [];
  let action: 'attack' | 'skill' = decision.action;
  let ability: Ability | null = null;
  if (action === 'skill') {
    if (actor.cooldown > 0) return { state, events: [], error: 'cooldown' };
    if (!isAbility(actor.ability)) {
      events.push({ t: 'warn', message: `malformed ability on ${actor.uid}; basic attack used instead` });
      action = 'attack';
    } else if (actor.energy < actor.ability.cost) {
      return { state, events: [], error: 'energy' };
    } else {
      ability = actor.ability;
    }
  }

  // Start of turn: status ticks first; a corpse or a stun burns the turn without acting.
  if (actor.hp <= 0 || tickStatuses(actor, events)) {
    events.push({ t: 'skip', uid: actor.uid, reason: 'down' });
    return finishAfterTurn(next, actor, events);
  }
  if (findStatus(actor, 'stun')) {
    events.push({ t: 'skip', uid: actor.uid, reason: 'stun' });
    return finishAfterTurn(next, actor, events);
  }

  events.push({ t: 'turn', uid: actor.uid, round: next.round });
  if (action === 'attack' || !ability) {
    events.push({ t: 'action', uid: actor.uid, action: 'attack' });
    const targets = resolveTargets(next, actor, 'enemy_active');
    for (const target of targets) {
      applyHit(next, actor, target, rollDamage(next, actor, target, effectiveStat(actor, 'atk')), 'attack', events);
    }
  } else {
    events.push({ t: 'action', uid: actor.uid, action: 'skill', abilityName: ability.name });
    actor.energy -= ability.cost;
    actor.cooldown = ability.cooldown > 0 ? ability.cooldown + 1 : 0;
    runOps(next, actor, ability.ops, events, 0);
  }
  return finishAfterTurn(next, actor, events);
}

/** End of turn: decay statuses and cooldown, drop the actor from the queue, move on. */
function finishAfterTurn(state: BattleState, actor: Combatant, events: BattleEvent[]): AdvanceResult {
  decayStatuses(actor);
  actor.cooldown = Math.max(0, actor.cooldown - 1);
  state.queue = state.queue.filter((uid) => uid !== actor.uid);
  advanceTurn(state, events);
  state.log.push(...events);
  return { state, events };
}

function advanceTurn(state: BattleState, events: BattleEvent[]): void {
  if (checkEnd(state, events)) return;
  if (state.queue.length > 0) {
    state.activeUid = state.queue[0];
    grantTurnEnergy(state, state.activeUid);
    return;
  }
  state.round += 1;
  if (state.modifier.kind === 'turn_limit' && state.round > state.modifier.turns) {
    endBattle(state, 'lost', 'turn_limit', events);
    return;
  }
  if (state.round > MAX_ROUNDS) {
    endBattle(state, 'draw', 'timeout', events);
    return;
  }
  state.queue = buildQueue(state);
  if (state.queue.length === 0) {
    endBattle(state, 'draw', 'hp', events);
    return;
  }
  events.push({ t: 'start', round: state.round });
  state.activeUid = state.queue[0];
  grantTurnEnergy(state, state.activeUid);
}

// ---------------------------------------------------------------------------
// Queue / battle end
// ---------------------------------------------------------------------------

function buildQueue(state: BattleState): string[] {
  return [...state.sides.a, ...state.sides.b]
    .filter((combatant) => combatant.hp > 0)
    .sort(
      (left, right) =>
        effectiveStat(right, 'spd') - effectiveStat(left, 'spd') ||
        (left.side === right.side ? left.slot - right.slot : left.side === 'a' ? -1 : 1)
    )
    .map((combatant) => combatant.uid);
}

function grantTurnEnergy(state: BattleState, uid: string): void {
  const combatant = findCombatant(state, uid);
  if (!combatant || combatant.hp <= 0) return;
  combatant.energy = Math.min(ENERGY_MAX, combatant.energy + ENERGY_PER_TURN);
}

function checkEnd(state: BattleState, events: BattleEvent[]): boolean {
  const aAlive = state.sides.a.some((combatant) => combatant.hp > 0);
  const bAlive = state.sides.b.some((combatant) => combatant.hp > 0);
  if (aAlive && bAlive) return false;
  if (!aAlive && !bAlive) endBattle(state, 'draw', 'hp', events);
  else if (!bAlive) endBattle(state, 'won', 'hp', events);
  else endBattle(state, 'lost', 'hp', events);
  return true;
}

function endBattle(state: BattleState, status: BattleState['status'], reason: 'hp' | 'turn_limit' | 'timeout', events: BattleEvent[]): void {
  state.status = status;
  state.endReason = reason;
  state.activeUid = null;
  state.queue = [];
  events.push({ t: 'end', status, round: state.round, reason });
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

function findStatus(combatant: Combatant, id: StatusId) {
  return combatant.statuses.find((status) => status.id === id);
}

function setStatus(combatant: Combatant, id: StatusId, turns: number, value: number): void {
  const existing = findStatus(combatant, id);
  if (existing) {
    existing.turns = turns;
    existing.value = value;
    return;
  }
  combatant.statuses.push({ id, turns, value });
}

function removeStatus(combatant: Combatant, id: StatusId): void {
  combatant.statuses = combatant.statuses.filter((status) => status.id !== id);
}

function decayStatuses(combatant: Combatant): void {
  for (const status of combatant.statuses) status.turns -= 1;
  combatant.statuses = combatant.statuses.filter((status) => status.turns > 0);
}

/** Poison then regen. Poison bypasses shield. Returns true (after emitting 'down') if it killed. */
function tickStatuses(actor: Combatant, events: BattleEvent[]): boolean {
  const poison = findStatus(actor, 'poison');
  if (poison && poison.value > 0) {
    actor.hp = Math.max(0, actor.hp - poison.value);
    events.push({ t: 'damage', uid: actor.uid, target: actor.uid, amount: poison.value, source: 'poison', crit: false, element: 'neutral', absorbed: 0 });
  }
  const regen = findStatus(actor, 'regen');
  if (regen && regen.value > 0) {
    const healed = Math.min(regen.value, actor.maxHp - actor.hp);
    if (healed > 0) {
      actor.hp += healed;
      events.push({ t: 'heal', uid: actor.uid, target: actor.uid, amount: healed, source: 'regen' });
    }
  }
  if (actor.hp <= 0) {
    events.push({ t: 'down', uid: actor.uid });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

interface Hit {
  amount: number;
  crit: boolean;
  element: 'strong' | 'weak' | 'neutral';
}

/** Fixed draw order per hit: variance, then crit. */
function rollDamage(state: BattleState, attacker: Combatant, defender: Combatant, attackValue: number): Hit {
  const def = effectiveStat(defender, 'def');
  const base = Math.max(1, attackValue * boostMultiplier(state, attacker.element) - def * DEF_FACTOR);
  const variance = 0.9 + nextRandom(state) * 0.2;
  const element = elementRelation(attacker.element, defender.element);
  const elementMult = element === 'strong' ? RING_STRONG : element === 'weak' ? RING_WEAK : 1;
  const crit = nextRandom(state) * 100 < attacker.crit;
  return {
    amount: Math.max(1, Math.round(base * variance * elementMult * (crit ? CRIT_MULT : 1))),
    crit,
    element
  };
}

function boostMultiplier(state: BattleState, element: Element): number {
  const modifier = state.modifier;
  return modifier.kind === 'element_boost' && modifier.element === element ? 1 + modifier.bonus : 1;
}

function elementRelation(attacker: Element, defender: Element): 'strong' | 'weak' | 'neutral' {
  const index = ELEMENT_RING.indexOf(attacker);
  if (index < 0) return 'neutral';
  if (ELEMENT_RING[(index + 1) % ELEMENT_RING.length] === defender) return 'strong';
  if (ELEMENT_RING[(index + ELEMENT_RING.length - 1) % ELEMENT_RING.length] === defender) return 'weak';
  return 'neutral';
}

/** Shield absorbs first; the event reports the pre-shield amount and the absorbed slice. */
function applyHit(state: BattleState, source: Combatant, target: Combatant, hit: Hit, kind: 'attack' | 'skill', events: BattleEvent[]): void {
  let amount = hit.amount;
  let absorbed = 0;
  const shield = findStatus(target, 'shield');
  if (shield && shield.value > 0) {
    absorbed = Math.min(shield.value, amount);
    shield.value -= absorbed;
    amount -= absorbed;
    if (shield.value <= 0) removeStatus(target, 'shield');
  }
  target.hp = Math.max(0, target.hp - amount);
  state.damageBy[source.uid] = (state.damageBy[source.uid] ?? 0) + hit.amount;
  events.push({ t: 'damage', uid: source.uid, target: target.uid, amount: hit.amount, source: kind, crit: hit.crit, element: hit.element, absorbed });
  if (target.hp <= 0) {
    // 'down' is emitted once, at the moment of death; dropping the uid here keeps a corpse
    // from ever being handed a turn (the turn-start check still covers poison deaths).
    events.push({ t: 'down', uid: target.uid });
    state.queue = state.queue.filter((uid) => uid !== target.uid);
  }
}

// ---------------------------------------------------------------------------
// Ability ops
// ---------------------------------------------------------------------------

function runOps(state: BattleState, actor: Combatant, ops: AbilityOp[], events: BattleEvent[], depth: number): void {
  if (depth > MAX_OP_DEPTH) return;
  for (const op of ops) {
    switch (op.op) {
      case 'damage': {
        const hits = clampHits(op.hits);
        for (const target of resolveTargets(state, actor, op.target ?? 'enemy_active')) {
          for (let hit = 0; hit < hits; hit += 1) {
            if (target.hp <= 0) break;
            applyHit(state, actor, target, rollDamage(state, actor, target, op.power), 'skill', events);
          }
        }
        break;
      }
      case 'heal': {
        for (const target of resolveTargets(state, actor, op.target ?? 'self')) {
          const healed = Math.min(op.amount, target.maxHp - target.hp);
          if (healed <= 0) continue;
          target.hp += healed;
          events.push({ t: 'heal', uid: actor.uid, target: target.uid, amount: healed, source: 'skill' });
        }
        break;
      }
      case 'shield': {
        for (const target of resolveTargets(state, actor, op.target ?? 'self')) {
          setStatus(target, 'shield', SHIELD_TURNS, op.amount);
          events.push({ t: 'shield', uid: actor.uid, target: target.uid, amount: op.amount });
        }
        break;
      }
      case 'apply_status': {
        for (const target of resolveTargets(state, actor, op.target ?? 'self')) {
          const applied = op.chance === undefined || nextRandom(state) * 100 < op.chance;
          if (applied) setStatus(target, op.status, op.turns, op.value ?? 0);
          events.push({ t: 'status', uid: actor.uid, target: target.uid, status: op.status, turns: op.turns, applied });
        }
        break;
      }
      case 'modify_stat': {
        for (const target of resolveTargets(state, actor, op.target ?? 'self')) {
          setStatus(target, op.status, op.turns, op.value);
          events.push({ t: 'status', uid: actor.uid, target: target.uid, status: op.status, turns: op.turns, applied: true });
        }
        break;
      }
      case 'conditional': {
        // The condition reference target is the first living enemy (deterministic).
        const reference = resolveTargets(state, actor, 'enemy_active')[0] ?? null;
        if (evalWhen(state, actor, reference, op.when)) runOps(state, actor, op.then, events, depth + 1);
        break;
      }
    }
  }
}

/** Self/target HP thresholds are percentages of maxHp (0..100). All clauses must pass. */
function evalWhen(state: BattleState, actor: Combatant, target: Combatant | null, when: AbilityCondition): boolean {
  if (when.selfHpBelow !== undefined && hpPercent(actor) >= when.selfHpBelow) return false;
  if (when.targetHpBelow !== undefined && (target === null || hpPercent(target) >= when.targetHpBelow)) return false;
  if (when.turnAtLeast !== undefined && state.round < when.turnAtLeast) return false;
  if (when.targetHasStatus !== undefined && (target === null || !findStatus(target, when.targetHasStatus))) return false;
  return true;
}

function hpPercent(combatant: Combatant): number {
  return combatant.maxHp <= 0 ? 0 : (combatant.hp / combatant.maxHp) * 100;
}

function resolveTargets(state: BattleState, actor: Combatant, target: AbilityTarget): Combatant[] {
  const enemies = livingOf(state, actor.side === 'a' ? 'b' : 'a');
  switch (target) {
    case 'enemy_active':
      return enemies.length > 0 ? [enemies[0]] : [];
    case 'enemy_lowest_hp': {
      const lowest = [...enemies].sort((left, right) => left.hp - right.hp || left.slot - right.slot)[0];
      return lowest ? [lowest] : [];
    }
    case 'enemy_all':
      return enemies;
    case 'self':
      return actor.hp > 0 ? [actor] : [];
    case 'ally_lowest_hp': {
      const allies = livingOf(state, actor.side);
      const lowest = [...allies].sort((left, right) => hpPercent(left) - hpPercent(right) || left.slot - right.slot)[0];
      return lowest ? [lowest] : [];
    }
    case 'ally_all':
      return livingOf(state, actor.side);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCombatant(state: BattleState, uid: string): Combatant | undefined {
  return state.sides.a.find((combatant) => combatant.uid === uid) ?? state.sides.b.find((combatant) => combatant.uid === uid);
}

function clampHits(hits: number | undefined): number {
  if (typeof hits !== 'number' || !Number.isFinite(hits)) return 1;
  return Math.min(MAX_HITS, Math.max(1, Math.floor(hits)));
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStatusId(value: unknown): value is StatusId {
  return typeof value === 'string' && (STATUS_IDS as readonly string[]).includes(value);
}

function isTarget(value: unknown): value is AbilityTarget | undefined {
  return value === undefined || (typeof value === 'string' && TARGETS.includes(value));
}

function isCondition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const when = value as Record<string, unknown>;
  if (when.selfHpBelow !== undefined && !isNumber(when.selfHpBelow)) return false;
  if (when.targetHpBelow !== undefined && !isNumber(when.targetHpBelow)) return false;
  if (when.turnAtLeast !== undefined && !isNumber(when.turnAtLeast)) return false;
  if (when.targetHasStatus !== undefined && !isStatusId(when.targetHasStatus)) return false;
  return true;
}

/** Untrusted-data guard: unknown ops, missing numbers and over-deep nesting all fail closed. */
function isOp(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  switch (op.op) {
    case 'damage':
      return isNumber(op.power) && (op.hits === undefined || isNumber(op.hits)) && isTarget(op.target);
    case 'heal':
    case 'shield':
      return isNumber(op.amount) && isTarget(op.target);
    case 'apply_status':
      return (
        isStatusId(op.status) &&
        isNumber(op.turns) &&
        (op.value === undefined || isNumber(op.value)) &&
        (op.chance === undefined || isNumber(op.chance)) &&
        isTarget(op.target)
      );
    case 'modify_stat':
      return isStatusId(op.status) && STAT_STATUS_IDS.includes(op.status) && isNumber(op.turns) && isNumber(op.value) && isTarget(op.target);
    case 'conditional':
      return depth < MAX_OP_DEPTH && isCondition(op.when) && Array.isArray(op.then) && op.then.every((then) => isOp(then, depth + 1));
    default:
      return false;
  }
}

function isAbility(value: unknown): value is Ability {
  if (value === null || typeof value !== 'object') return false;
  const ability = value as Record<string, unknown>;
  if (typeof ability.id !== 'string' || typeof ability.name !== 'string') return false;
  if (!isNumber(ability.cost) || ability.cost < 0) return false;
  if (!isNumber(ability.cooldown) || ability.cooldown < 0) return false;
  if (!Array.isArray(ability.ops) || ability.ops.length === 0) return false;
  return ability.ops.every((op) => isOp(op, 0));
}
