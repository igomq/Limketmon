// KST daily challenge. Pure: the KST date string is the ONLY input, so every
// user sees the same challenge, rules and opponent on the same KST date.
import { ELEMENTS, ELEMENT_LABEL, type BattleModifier, type Element } from './battle/types.ts';
import type { Rarity } from './rules.ts';

export interface DailyChallenge {
  id: string;
  date: string;
  title: string;
  description: string;
  ruleLabel: string;
  opponentId: string;
  maxRarity?: Rarity;
  modifier: BattleModifier;
  rewardCredits: number;
}

/** Rotation order; ids must match lib/battle/opponents.ts. */
const DAILY_OPPONENT_IDS = ['rookie', 'regular', 'veteran', 'ace', 'boss'] as const;
const RULE_KINDS = ['rarity_cap', 'element_boost', 'turn_limit', 'none'] as const;

export const DAILY_REWARD_CREDITS = 3;

/** Fixed phase offset; 4 rule kinds and 5 opponents share no cycle before day 20. */
const ROTATION_OFFSET = 3;

export function dailyClaimKey(kstDate: string): string {
  return `daily:${kstDate}`;
}

function parseStamp(kstDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(kstDate);
  const stamp = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (Number.isNaN(stamp) || new Date(stamp).toISOString().slice(0, 10) !== kstDate) {
    throw new RangeError(`invalid KST date: ${kstDate}`);
  }
  return stamp;
}

export function dailyChallenge(kstDate: string): DailyChallenge {
  const stamp = parseStamp(kstDate);
  const year = Number(kstDate.slice(0, 4));
  const dayOfYear = Math.round((stamp - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  // Consecutive days advance both lanes by one, so opponent and rule both change.
  const index = dayOfYear + ROTATION_OFFSET;
  const kind = RULE_KINDS[index % RULE_KINDS.length];
  const opponentId = DAILY_OPPONENT_IDS[index % DAILY_OPPONENT_IDS.length];
  const cycle = Math.floor(index / RULE_KINDS.length);
  const base = {
    id: `daily-${kstDate}`,
    date: kstDate,
    opponentId,
    rewardCredits: DAILY_REWARD_CREDITS
  };

  if (kind === 'rarity_cap') {
    const max: Rarity = cycle % 2 === 0 ? 'R' : 'SR';
    return {
      ...base,
      title: `${max} 등급 제한`,
      description: `${max} 등급 이하 카드만으로 덱을 구성해 승리하세요.`,
      ruleLabel: `${max} 등급 이하 제한`,
      maxRarity: max,
      modifier: { kind: 'rarity_cap', max }
    };
  }
  if (kind === 'element_boost') {
    const element: Element = ELEMENTS[index % ELEMENTS.length];
    const label = ELEMENT_LABEL[element];
    return {
      ...base,
      title: `${label} 속성 강화`,
      description: `${label} 속성 카드의 피해량이 25% 증가합니다.`,
      ruleLabel: `${label} 속성 강화`,
      modifier: { kind: 'element_boost', element, bonus: 0.25 }
    };
  }
  if (kind === 'turn_limit') {
    return {
      ...base,
      title: '라운드 제한',
      description: '12라운드 안에 승리해야 합니다.',
      ruleLabel: '12라운드 제한',
      modifier: { kind: 'turn_limit', turns: 12 }
    };
  }
  return {
    ...base,
    title: '자유 대전',
    description: '특별한 제한 없이 겨룹니다.',
    ruleLabel: '제한 없음',
    modifier: { kind: 'none' }
  };
}
