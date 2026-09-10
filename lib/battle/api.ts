// Wire contract shared by the battle API routes and the client screens.
import type { BattleKind, BattleModifier, CombatantSeed } from './types.ts';

export interface DeckSummary {
  id: string;
  name: string;
  isDefault: boolean;
  cards: string[];
}

export interface DailyChallengeSummary {
  id: string;
  date: string;
  title: string;
  description: string;
  ruleLabel: string;
  opponentId: string;
  opponentName: string;
  cleared: boolean;
  rewardCredits: number;
  modifier: BattleModifier;
}

export interface BattleSetupResponse {
  battleId: string;
  ruleset: number;
  seed: number;
  kind: BattleKind;
  opponentId: string;
  opponentName: string;
  opponentTitle: string;
  difficulty: string;
  modifier: BattleModifier;
  player: CombatantSeed[];
  opponent: CombatantSeed[];
}

export interface RewardLine {
  readonly label: string;
  readonly credits: number;
}

export interface BattleResultSummary {
  readonly result: 'won' | 'lost' | 'draw' | 'invalid';
  readonly rewards: RewardLine[];
  readonly unlocked: string[];
  readonly mvpCardId: string | null;
  readonly rounds: number;
  readonly damageDealt: number;
}

/** One stored battle, enough for the record screen to list and replay it. */
export interface BattleSummaryRow {
  id: string;
  kind: string;
  opponentId: string;
  opponentName: string;
  result: string;
  rounds: number;
  damageDealt: number;
  mvpCardId: string | null;
  kstDate: string;
  createdAt: string;
}

export interface StatsSummary {
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
  streak: number;
  bestStreak: number;
  totalPulls: number;
  pullsByRarity: Record<string, number>;
  topCards: Array<{ cardId: string; uses: number; wins: number }>;
  rarityUsage: Record<string, number>;
  bossClears: number;
  dailyClears: number;
  achievements: Array<{ id: string; name: string; description: string; reward: number; unlockedAt: string | null }>;
  /** Achievement ids whose condition currently holds, unlocked or not. */
  satisfied: string[];
}
