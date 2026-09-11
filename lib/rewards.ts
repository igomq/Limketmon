// Battle reward policy. Pure: it decides what MAY be claimed, never writes.
import { dailyClaimKey, DAILY_REWARD_CREDITS } from './daily.ts';
import type { BattleMode } from './battle/types.ts';

export interface BattleRewardInput {
  kind: 'pve' | 'daily';
  opponentId: string;
  mode?: BattleMode;
  result: 'won' | 'lost' | 'draw';
  kstDate: string;
  firstClear: boolean;
}

export interface RewardPlan {
  credits: number;
  claims: string[];
  lines: Array<{ label: string; credits: number }>;
}

/** Normal keeps the historical key; hard/chaos namespace their own first-clear per opponent. */
export function pveFirstClearClaimKey(opponentId: string, mode: BattleMode = 'normal'): string {
  return mode === 'normal' ? `pve_first:${opponentId}` : `pve_first:${mode}:${opponentId}`;
}

/** One ticket drop per battle, so the claim key is the battle id. */
export function ticketDropClaimKey(battleId: string): string {
  return `ticket:${battleId}`;
}

/**
 * Guaranteed-pull ticket drop odds per mode, as exclusive cumulative ranges: sr wins [0, sr),
 * ssr wins [sr, ssr). Normal 10%/2%, hard 20%/5%, chaos 30%/10%.
 */
const TICKET_DROP_ODDS: Record<BattleMode, { sr: number; ssr: number }> = {
  normal: { sr: 0.1, ssr: 0.12 },
  hard: { sr: 0.2, ssr: 0.25 },
  chaos: { sr: 0.3, ssr: 0.4 }
};

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pure ticket drop helper for testing and simulations given a uniform random float in [0, 1).
 */
export function rollTicketDrop(mode: BattleMode, unit: number): 'sr' | 'ssr' | null {
  const odds = TICKET_DROP_ODDS[mode];
  if (unit < odds.sr) return 'sr';
  if (unit < odds.ssr) return 'ssr';
  return null;
}

const EMPTY: RewardPlan = { credits: 0, claims: [], lines: [] };

/** Repeat wins pay nothing: only a first PvE clear or the daily win carry credits. */
export function planBattleRewards(input: BattleRewardInput, firstClearCredits: number): RewardPlan {
  if (input.result !== 'won') return EMPTY;
  if (input.kind === 'daily') {
    return {
      credits: DAILY_REWARD_CREDITS,
      claims: [dailyClaimKey(input.kstDate)],
      lines: [{ label: '데일리 챌린지 보상', credits: DAILY_REWARD_CREDITS }]
    };
  }
  if (!input.firstClear) return EMPTY;
  return {
    credits: firstClearCredits,
    claims: [pveFirstClearClaimKey(input.opponentId, input.mode)],
    lines: [{ label: '첫 격파 보상', credits: firstClearCredits }]
  };
}
