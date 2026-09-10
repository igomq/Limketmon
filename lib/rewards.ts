// Battle reward policy. Pure: it decides what MAY be claimed, never writes.
import { dailyClaimKey, DAILY_REWARD_CREDITS } from './daily.ts';

export interface BattleRewardInput {
  kind: 'pve' | 'daily';
  opponentId: string;
  result: 'won' | 'lost' | 'draw';
  kstDate: string;
  firstClear: boolean;
}

export interface RewardPlan {
  credits: number;
  claims: string[];
  lines: Array<{ label: string; credits: number }>;
}

export function pveFirstClearClaimKey(opponentId: string): string {
  return `pve_first:${opponentId}`;
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
    claims: [pveFirstClearClaimKey(input.opponentId)],
    lines: [{ label: '첫 격파 보상', credits: firstClearCredits }]
  };
}
