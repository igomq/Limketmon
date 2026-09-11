// Glue between the curated card catalog and the pure battle engine.
import manifest from '../data/cards.curated.json';
import { applyEnhance, clampEnhance } from '../enhance.ts';
import type { Card } from '../cards.ts';
import type { BattleSetup, BattleMode, CombatantSeed, BattleKind, BattleModifier, Decision, BattleState } from './types.ts';
import { battleStats } from './stats.ts';
import { scaleAbility, unlockedEnhanceSkills } from './enhance-skills.ts';
import { opponentById } from './opponents.ts';

export const CATALOG: Card[] = manifest.cards as Card[];
export const CARD_BY_ID: Map<string, Card> = new Map(CATALOG.map((card) => [card.id, card]));

export class SetupError extends Error {}

export function combatantSeed(cardId: string, hpScale = 1, enhanceLevel = 0): CombatantSeed {
  const card = CARD_BY_ID.get(cardId);
  if (!card) throw new SetupError(`unknown card: ${cardId}`);
  const level = clampEnhance(enhanceLevel);
  const stats = applyEnhance(battleStats(card), level, card.rarity);
  // The raw signature was tuned against un-normalized stats; scale its flat numbers so a high
  // rarity or a high enhance level keeps the signature relevant next to the card's own stats.
  const ability = scaleAbility(stats.ability, card.rarity, level);
  const skills = unlockedEnhanceSkills(card, stats, level).map((skill) => skill.ability);
  return {
    cardId: card.id,
    name: card.skillName ? card.alias?.replace(/[「」]/g, '') || card.name : card.name,
    rarity: card.rarity,
    element: stats.element,
    maxHp: Math.max(1, Math.round(stats.maxHp * hpScale)),
    atk: stats.atk,
    def: stats.def,
    spd: stats.spd,
    crit: stats.crit,
    ability,
    skills,
    enhance: level
  };
}

export function playerTeam(cardIds: string[], enhanceLevels: number[] = []): CombatantSeed[] {
  return cardIds.map((cardId, index) => combatantSeed(cardId, 1, enhanceLevels[index] ?? 0));
}

export function opponentTeam(opponentId: string, mode: BattleMode = 'normal'): CombatantSeed[] {
  const opponent = opponentById(opponentId, mode);
  if (!opponent) throw new SetupError(`unknown opponent: ${opponentId}`);
  const statScale = opponent.statScale ?? 1;
  return opponent.cards.map((cardId) => {
    const seed = combatantSeed(cardId, opponent.hpScale);
    if (statScale === 1) return seed;
    return {
      ...seed,
      atk: Math.max(1, Math.round(seed.atk * statScale)),
      def: Math.max(1, Math.round(seed.def * statScale))
    };
  });
}

export function buildSetup(options: {
  kind: BattleKind;
  opponentId: string;
  modifier: BattleModifier;
  seed: number;
  playerCardIds: string[];
  playerEnhance?: number[];
  mode?: BattleMode;
  battleId?: string;
}): BattleSetup {
  return {
    battleId: options.battleId,
    kind: options.kind,
    mode: options.mode ?? 'normal',
    opponentId: options.opponentId,
    modifier: options.modifier,
    seed: options.seed >>> 0,
    player: playerTeam(options.playerCardIds, options.playerEnhance),
    opponent: opponentTeam(options.opponentId, options.mode ?? 'normal')
  };
}

/** Deterministic AI entry point: the profile is looked up from the battle's opponent id. */
export type Decider = (state: BattleState) => Decision;

export function aiProfileFor(opponentId: string, mode: BattleMode = 'normal') {
  const opponent = opponentById(opponentId, mode);
  if (!opponent) throw new SetupError(`unknown opponent: ${opponentId}`);
  return opponent.profile;
}
