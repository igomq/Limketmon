// Battle reward policy. Pure: it decides what MAY be claimed, never writes.
import { dailyClaimKey, DAILY_REWARD_CREDITS } from './daily.ts';
import type { BattleMode } from './battle/types.ts';
import type { TicketType } from './pull.ts';

export interface BattleRewardInput {
  kind: 'pve' | 'daily';
  opponentId: string;
  mode?: BattleMode;
  result: 'won' | 'lost' | 'draw';
  kstDate: string;
  firstClear: boolean;
  /**
   * The settling battle's id. The always-on win payout is gated by a per-battle claim key derived
   * from it, so re-settling the same battle can never pay twice.
   */
  battleId: string;
}

/** One claim row the settlement inserts. Ticket claims carry ticketType/quantity, credit claims not. */
export interface RewardClaim {
  key: string;
  credits: number;
  ticketType?: TicketType;
  quantity?: number;
}

export interface RewardLine {
  label: string;
  credits: number;
  ticketType?: TicketType;
  quantity?: number;
}

export interface RewardPlan {
  credits: number;
  claims: RewardClaim[];
  lines: RewardLine[];
}

/** Normal keeps the historical key; hard/chaos namespace their own first-clear per opponent. */
export function pveFirstClearClaimKey(opponentId: string, mode: BattleMode = 'normal'): string {
  return mode === 'normal' ? `pve_first:${opponentId}` : `pve_first:${mode}:${opponentId}`;
}

/** Per-battle key gating the always-on win payout so a re-settle cannot pay a second time. */
export function ticketDropClaimKey(battleId: string): string {
  return `ticket:${battleId}`;
}

/**
 * Fixed ticket paid for every win, by mode and opponent. Normal pays low tickets for the lower
 * opponents and normal tickets for ace/boss; hard pays normal tickets (SR+ for the boss); chaos
 * pays SR+ (SSR+ for ace/boss). The first clear pays the same type and quantity once more.
 */
const VICTORY_TICKETS: Record<BattleMode, Record<string, { ticketType: TicketType; quantity: number }>> = {
  normal: {
    rookie: { ticketType: 'low', quantity: 2 },
    regular: { ticketType: 'low', quantity: 3 },
    veteran: { ticketType: 'low', quantity: 4 },
    ace: { ticketType: 'normal', quantity: 2 },
    boss: { ticketType: 'normal', quantity: 3 }
  },
  hard: {
    rookie: { ticketType: 'normal', quantity: 3 },
    regular: { ticketType: 'normal', quantity: 4 },
    veteran: { ticketType: 'normal', quantity: 5 },
    ace: { ticketType: 'normal', quantity: 6 },
    boss: { ticketType: 'sr', quantity: 2 }
  },
  chaos: {
    rookie: { ticketType: 'sr', quantity: 2 },
    regular: { ticketType: 'sr', quantity: 3 },
    veteran: { ticketType: 'sr', quantity: 4 },
    ace: { ticketType: 'ssr', quantity: 2 },
    boss: { ticketType: 'ssr', quantity: 3 }
  }
};

/** The ticket a single win pays, before the first-clear extra. */
export function victoryTicketReward(mode: BattleMode, opponentId: string): { ticketType: TicketType; quantity: number } {
  const table = VICTORY_TICKETS[mode] ?? VICTORY_TICKETS.normal;
  return table[opponentId] ?? { ticketType: 'low', quantity: 0 };
}

const EMPTY: RewardPlan = { credits: 0, claims: [], lines: [] };

/**
 * A win pays its fixed ticket every time; the first clear pays the same ticket a second time under
 * the per-opponent/mode first-clear key. Daily keeps only its existing first-win credit reward.
 */
export function planBattleRewards(input: BattleRewardInput, firstClearCredits: number): RewardPlan {
  if (input.result !== 'won') return EMPTY;
  if (input.kind === 'daily') {
    return {
      credits: DAILY_REWARD_CREDITS,
      claims: [{ key: dailyClaimKey(input.kstDate), credits: DAILY_REWARD_CREDITS }],
      lines: [{ label: '데일리 챌린지 보상', credits: DAILY_REWARD_CREDITS }]
    };
  }
  const mode = input.mode ?? 'normal';
  const ticket = victoryTicketReward(mode, input.opponentId);
  const paysTicket = ticket.quantity > 0;
  const claims: RewardClaim[] = [];
  const lines: RewardLine[] = [];
  if (input.firstClear) {
    claims.push({
      key: pveFirstClearClaimKey(input.opponentId, mode),
      credits: firstClearCredits,
      ...(paysTicket ? { ticketType: ticket.ticketType, quantity: ticket.quantity } : {})
    });
    lines.push({
      label: '첫 격파 보상',
      credits: firstClearCredits,
      ...(paysTicket ? { ticketType: ticket.ticketType, quantity: ticket.quantity } : {})
    });
  }
  if (paysTicket) {
    claims.push({ key: ticketDropClaimKey(input.battleId), credits: 0, ticketType: ticket.ticketType, quantity: ticket.quantity });
    lines.push({ label: '승리 보상', credits: 0, ticketType: ticket.ticketType, quantity: ticket.quantity });
  }
  return { credits: claims.reduce((sum, claim) => sum + claim.credits, 0), claims, lines };
}

