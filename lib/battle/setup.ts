// Glue between the curated card catalog and the pure battle engine.
import manifest from '../data/cards.curated.json';
import { applyEnhance, clampEnhance } from '../enhance.ts';
import { effectiveCard, type CardProgress } from '../progression.ts';
import type { Rarity } from '../rules.ts';
import type { Card } from '../cards.ts';
import {
  positionOf,
  type BattleKind,
  type BattleMode,
  type BattleModifier,
  type BattleSetup,
  type BattleState,
  type CardBattleStats,
  type CombatantSeed,
  type Decision,
  type Position
} from './types.ts';
import { RARITIES, battleStats, catalogCard } from './stats.ts';
import { scaleAbility, unlockedEnhanceSkills } from './enhance-skills.ts';
import { opponentById } from './opponents.ts';

export const CATALOG: Card[] = manifest.cards as Card[];
export const CARD_BY_ID: Map<string, Card> = new Map(CATALOG.map((card) => [card.id, card]));

export class SetupError extends Error {}

/** Limited role compensation, applied to both sides; the card keeps its own stat shape. */
const ROLE_BULK_BONUS = 0.1;
const ROLE_DEALER_BONUS = 0.05;
const ROLE_SUPPORT_SPD = 2;

const RARITY_SET: ReadonlySet<string> = new Set(RARITIES);

/**
 * The owned card row a battle seed is built from. A catalog id resolves to the catalog card; a
 * synthesized row (fusion/transcendence) carries its own owned id, base id and effective rarity,
 * so the seed keeps the owned identity even when the rarity override matches the base rarity.
 * Rows are validated where they are stored (parseDeckSlots rejects anything malformed), so the
 * only check left here is the one that would otherwise turn stats into NaN.
 */
function resolveCard(cardId: string, progress?: CardProgress): Card {
  if (!progress) {
    const card = CARD_BY_ID.get(cardId);
    if (!card) throw new SetupError(`unknown card: ${cardId}`);
    return card;
  }
  const base = CARD_BY_ID.get(progress.baseCardId);
  if (!base) throw new SetupError(`unknown card: ${progress.baseCardId}`);
  if (!isRarity(progress.rarity)) throw new SetupError(`unknown rarity: ${progress.rarity}`);
  return effectiveCard(base, cardId, progress.rarity);
}

function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && RARITY_SET.has(value);
}

export function combatantSeed(cardId: string, hpScale = 1, enhanceLevel = 0, progress?: CardProgress): CombatantSeed {
  const card = resolveCard(cardId, progress);
  const level = clampEnhance(progress?.enhanceLevel ?? enhanceLevel);
  const base = applyEnhance(battleStats(card), level, card.rarity);
  // The raw signature was tuned against un-normalized stats; scale its flat numbers so a high
  // rarity or a high enhance level keeps the signature relevant next to the card's own stats.
  const signature = scaleAbility(base.ability, card.rarity, level, catalogCard(card).rarity);
  const position = positionOf(signature);
  const stats = applyRole({ ...base, ability: signature }, position);
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
    ability: stats.ability,
    skills,
    enhance: level,
    position,
    traits: (progress?.traits ?? []).map((trait) => ({ ...trait }))
  };
}

/**
 * Position comes from the ability ops; the bonus it grants is deliberately small, and healer and
 * tank share the spec's HP/DEF +10% branch so an ability's flat numbers never depend on its role.
 */
function applyRole(stats: CardBattleStats, position: Position): CardBattleStats {
  switch (position) {
    case 'healer':
    case 'tank':
      return {
        ...stats,
        maxHp: Math.max(1, Math.round(stats.maxHp * (1 + ROLE_BULK_BONUS))),
        def: Math.max(1, Math.round(stats.def * (1 + ROLE_BULK_BONUS)))
      };
    case 'dealer':
      return { ...stats, atk: Math.max(1, Math.round(stats.atk * (1 + ROLE_DEALER_BONUS))) };
    case 'support':
      return { ...stats, spd: stats.spd + ROLE_SUPPORT_SPD };
  }
}

export function playerTeam(
  cardIds: string[],
  enhanceLevels: number[] = [],
  progress: CardProgress[] = []
): CombatantSeed[] {
  return cardIds.map((cardId, index) => combatantSeed(cardId, 1, enhanceLevels[index] ?? 0, progress[index]));
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
  /** One entry per deck slot, in slot order: the owned row the slot refers to. */
  playerProgress?: CardProgress[];
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
    player: playerTeam(options.playerCardIds, options.playerEnhance, options.playerProgress),
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
