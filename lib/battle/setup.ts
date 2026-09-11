// Glue between the curated card catalog and the pure battle engine.
import manifest from '../data/cards.curated.json';
import { applyEnhance, clampEnhance } from '../enhance.ts';
import type { Card } from '../cards.ts';
import type { BattleSetup, CombatantSeed, BattleKind, BattleModifier, Decision, BattleState } from './types.ts';
import { battleStats } from './stats.ts';
import { opponentById } from './opponents.ts';

export const CATALOG: Card[] = manifest.cards as Card[];
export const CARD_BY_ID: Map<string, Card> = new Map(CATALOG.map((card) => [card.id, card]));

export class SetupError extends Error {}

export function combatantSeed(cardId: string, hpScale = 1, enhanceLevel = 0): CombatantSeed {
  const card = CARD_BY_ID.get(cardId);
  if (!card) throw new SetupError(`unknown card: ${cardId}`);
  const stats = applyEnhance(battleStats(card), enhanceLevel);
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
    ability: stats.ability,
    enhance: clampEnhance(enhanceLevel)
  };
}

export function playerTeam(cardIds: string[], enhanceLevels: number[] = []): CombatantSeed[] {
  return cardIds.map((cardId, index) => combatantSeed(cardId, 1, enhanceLevels[index] ?? 0));
}

export function opponentTeam(opponentId: string): CombatantSeed[] {
  const opponent = opponentById(opponentId);
  if (!opponent) throw new SetupError(`unknown opponent: ${opponentId}`);
  return opponent.cards.map((cardId) => combatantSeed(cardId, opponent.hpScale));
}

export function buildSetup(options: {
  kind: BattleKind;
  opponentId: string;
  modifier: BattleModifier;
  seed: number;
  playerCardIds: string[];
  playerEnhance?: number[];
  battleId?: string;
}): BattleSetup {
  return {
    battleId: options.battleId,
    kind: options.kind,
    opponentId: options.opponentId,
    modifier: options.modifier,
    seed: options.seed >>> 0,
    player: playerTeam(options.playerCardIds, options.playerEnhance),
    opponent: opponentTeam(options.opponentId)
  };
}

/** Deterministic AI entry point: the profile is looked up from the battle's opponent id. */
export type Decider = (state: BattleState) => Decision;

export function aiProfileFor(opponentId: string) {
  const opponent = opponentById(opponentId);
  if (!opponent) throw new SetupError(`unknown opponent: ${opponentId}`);
  return opponent.profile;
}
