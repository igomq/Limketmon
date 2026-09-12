// Deterministic heuristic opponent. Pure: the same state always yields the same decision,
// with no randomness of its own, so the server re-simulation and the client preview agree.
//
// Priorities, in order:
//   1. lethal   — finish a target the basic attack can already kill
//   2. rescue   — heal or shield an ally that dropped below the profile's heal threshold
//   3. skill    — spend energy on the ability, gated by skillAppetite and skillMinTargets
//   4. attack   — always available, always legal
import type { AbilityCondition, AbilityOp, AiProfile, BattleState, Combatant, Decision } from './types.ts';
import { ELEMENT_RING } from './types.ts';
import { effectiveStat, livingOf } from './engine.ts';

const RING_STRONG = 1.25;
const RING_WEAK = 0.8;
const DEF_FACTOR = 0.45;

export function aiDecision(state: BattleState, profile: AiProfile): Decision {
  const uid = state.activeUid;
  if (!uid) throw new Error('no active combatant');
  const actor = find(state, uid);
  if (!actor) throw new Error(`active combatant ${uid} is missing`);
  const attack: Decision = { uid, action: 'attack' };

  const skillReady = actor.energy >= actor.ability.cost && actor.cooldown <= 0;
  if (!skillReady) return attack;

  const enemies = livingOf(state, actor.side === 'a' ? 'b' : 'a');
  const allies = livingOf(state, actor.side);

  // 1. A basic attack that already kills beats saving energy.
  if (profile.lethalFirst) {
    const target = weakestTarget(state, enemies, actor);
    if (target && estimateAttackDamage(state, actor, target) >= target.hp) return attack;
  }

  // 2. Skills that keep the team alive are worth their energy when someone is hurt.
  const rescue = hasOp(actor.ability.ops, 'heal') || hasOp(actor.ability.ops, 'shield');
  if (rescue) {
    const hurt = allies.some((ally) => ally.hp / ally.maxHp <= profile.healBelow);
    // Only spend the energy when the ability would actually change something: a conditional
    // heal whose threshold is not met would burn a turn for nothing.
    if (hurt && deservesEnergy(state, actor)) return { uid, action: 'skill' };
  }

  // 3. AoE skills are wasted against a single survivor unless the profile says otherwise.
  const hitsAll = hasTarget(actor.ability.ops, 'enemy_all');
  if (hitsAll && enemies.length / Math.max(1, state.sides.b.length) < profile.skillMinTargets) {
    return attack;
  }

  // 4. Appetite gates the remaining skills: a cautious profile waits for surplus energy.
  const surplus = Math.max(0, Math.round((1 - profile.skillAppetite) * 4));
  const worth = actor.energy >= actor.ability.cost && energyPaysOff(state, actor, hitsAll);
  return worth && actor.energy >= actor.ability.cost + surplus ? { uid, action: 'skill' } : attack;
}

/** True when at least one op in the ability would have a visible effect right now. */
function deservesEnergy(state: BattleState, actor: Combatant): boolean {
  return opsPayOff(state, actor, actor.ability.ops);
}

/** Damage always pays off; healing only when hurt; a conditional only when its clauses hold. */
function energyPaysOff(state: BattleState, actor: Combatant, hitsAll: boolean): boolean {
  if (hitsAll) return true;
  return opsPayOff(state, actor, actor.ability.ops);
}

function opsPayOff(state: BattleState, actor: Combatant, ops: readonly AbilityOp[]): boolean {
  return ops.some((op) => {
    if (op.op === 'conditional') {
      return conditionsHold(state, actor, op.when) && opsPayOff(state, actor, op.then);
    }
    if (op.op === 'heal') return actor.hp < actor.maxHp;
    if (op.op === 'damage') return livingOf(state, actor.side === 'a' ? 'b' : 'a').length > 0;
    return true;
  });
}

/** Mirrors the engine's condition evaluation so the AI and the engine never disagree. */
function conditionsHold(state: BattleState, actor: Combatant, when: AbilityCondition): boolean {
  if (when.selfHpBelow !== undefined && actor.maxHp > 0 && (actor.hp / actor.maxHp) * 100 >= when.selfHpBelow) return false;
  if (when.turnAtLeast !== undefined && state.round < when.turnAtLeast) return false;
  if (when.targetHpBelow !== undefined || when.targetHasStatus !== undefined) {
    const enemies = livingOf(state, actor.side === 'a' ? 'b' : 'a');
    const target = [...enemies].sort((left, right) => left.hp - right.hp || left.slot - right.slot)[0];
    if (!target) return false;
    if (when.targetHpBelow !== undefined && (target.hp / target.maxHp) * 100 >= when.targetHpBelow) return false;
    if (when.targetHasStatus !== undefined && !target.statuses.some((entry) => entry.id === when.targetHasStatus)) return false;
  }
  return true;
}

/** Opponent id -> profile, so battle rows can be replayed without extra lookups. */
export function deciderFor(profile: AiProfile) {
  return (state: BattleState) => aiDecision(state, profile);
}

function find(state: BattleState, uid: string): Combatant | undefined {
  return (
    state.sides.a.find((combatant) => combatant.uid === uid) ??
    state.sides.b.find((combatant) => combatant.uid === uid)
  );
}

/** Lowest-HP living enemy; the engine's own single-target resolution picks the same class of target. */
function weakestTarget(state: BattleState, enemies: Combatant[], actor: Combatant): Combatant | undefined {
  const target = [...enemies].sort((left, right) => left.hp - right.hp || left.slot - right.slot)[0];
  return target ? withActorContext(state, actor, target) : undefined;
}

/** Kept separate so the lethal estimate reads the boost modifier exactly like the engine does. */
function withActorContext(_state: BattleState, _actor: Combatant, target: Combatant): Combatant {
  return target;
}

/**
 * Conservative estimate of a basic attack: the engine's average roll (variance 1.0, no crit).
 * Underestimating is deliberate — the AI only calls lethal when the target is certain to fall.
 */
export function estimateAttackDamage(state: BattleState, attacker: Combatant, defender: Combatant): number {
  return estimateDamage(state, attacker, defender, effectiveStat(attacker, 'atk'));
}

export function estimateDamage(state: BattleState, attacker: Combatant, defender: Combatant, power: number): number {
  const boost = state.modifier.kind === 'element_boost' && state.modifier.element === attacker.element
    ? 1 + state.modifier.bonus
    : 1;
  const base = Math.max(1, power * boost - effectiveStat(defender, 'def') * DEF_FACTOR);
  const ring = elementMultiplier(attacker.element, defender.element);
  return Math.max(1, Math.round(base * ring));
}

function elementMultiplier(attacker: string, defender: string): number {
  const from = ELEMENT_RING.indexOf(attacker as (typeof ELEMENT_RING)[number]);
  const to = ELEMENT_RING.indexOf(defender as (typeof ELEMENT_RING)[number]);
  if (from < 0 || to < 0) return 1;
  if ((from + 1) % ELEMENT_RING.length === to) return RING_STRONG;
  if ((to + 1) % ELEMENT_RING.length === from) return RING_WEAK;
  return 1;
}

function hasOp(ops: readonly AbilityOp[], op: string): boolean {
  return ops.some((entry) => entry.op === op || (entry.op === 'conditional' && hasOp(entry.then, op)));
}

function hasTarget(ops: readonly AbilityOp[], target: string): boolean {
  return ops.some(
    (entry) =>
      (entry.op !== 'conditional' && (entry.target ?? 'enemy_active') === target) ||
      (entry.op === 'conditional' && hasTarget(entry.then, target))
  );
}
