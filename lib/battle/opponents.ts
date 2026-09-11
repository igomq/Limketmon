// Five curated PvE opponents. Difficulty is deck composition + AI profile + hpScale,
// never HP alone: rookie runs three N cards at reduced HP, boss runs the highest rarities.
import { BATTLE_MODES, type BattleMode, type Opponent } from './types.ts';

export { BATTLE_MODES };

/** Korean labels the UI renders verbatim. 'hard' is 하드 (고급 is not used for the mode). */
export const MODE_LABELS: Record<BattleMode, string> = {
  normal: '일반',
  hard: '하드',
  chaos: '카오스'
};

/** First-clear credit multiplier per mode. */
export const MODE_CREDITS_MULTIPLIER: Record<BattleMode, number> = {
  normal: 1,
  hard: 2,
  chaos: 4
};

interface ModeTuning {
  hp: number;
  stat: number;
  heal: number;
  appetite: number;
  ruthless: boolean;
}

/** Mode difficulty rides on top of the base ladder: scaling HP, ATK/DEF, and AI aggression. */
const MODE_TUNING: Record<BattleMode, ModeTuning> = {
  normal: { hp: 1, stat: 1.06, heal: 0.95, appetite: 1.1, ruthless: false },
  hard: { hp: 1.5, stat: 1.5, heal: 0.85, appetite: 1.25, ruthless: true },
  chaos: { hp: 2.1, stat: 2.1, heal: 0.7, appetite: 1.4, ruthless: true }
};

export const OPPONENTS: Opponent[] = [
  {
    id: 'rookie',
    name: '루키 조교',
    title: '첫 대련',
    difficulty: 'beginner',
    blurb: '연습용 카드 세 장. 스킬을 아껴 쓰고 힐을 자주 넣는다. 조합된 N/R 덱으로 도전하세요.',
    cards: ['imsingyu-v002', 'imsingyu-v019', 'imsingyu-v003'],
    hpScale: 0.9,
    // Healing only when genuinely hurt: a 0.95 threshold made the beginner AI heal every turn
    // and turned the bracket into stalemates.
    profile: { healBelow: 0.9, lethalFirst: false, skillMinTargets: 0, skillAppetite: 0.35 },
    reward: { credits: 2, label: '첫 승리 보상' }
  },
  {
    id: 'regular',
    name: '단골 도전자',
    title: '기본 전술',
    difficulty: 'normal',
    blurb: '수비형 N 카드와 R 카드 한 장. 힐과 스킬을 반반 섞는다.',
    cards: ['imsingyu-v005', 'imsingyu-v008', 'imsingyu-v012'],
    hpScale: 1,
    profile: { healBelow: 0.85, lethalFirst: false, skillMinTargets: 0, skillAppetite: 0.5 },
    reward: { credits: 3, label: '일반 승리 보상' }
  },
  {
    id: 'veteran',
    name: '파티 베테랑',
    title: '상태이상 운용',
    difficulty: 'normal',
    blurb: 'R 두 장에 SR 지원 카드. 상대가 셋 다 살아 있을 때만 스킬을 쓴다.',
    cards: ['imsingyu-v013', 'imsingyu-v030', 'imsingyu-v007'],
    hpScale: 1.08,
    profile: { healBelow: 0.7, lethalFirst: false, skillMinTargets: 0.5, skillAppetite: 0.7 },
    reward: { credits: 4, label: '숙련 승리 보상' }
  },
  {
    id: 'ace',
    name: '에이스',
    title: '결정타 우선',
    difficulty: 'hard',
    blurb: 'SR 두 장에 R 한 장. 마무리 가능하면 힐보다 딜을 고른다.',
    cards: ['imsingyu-v001', 'imsingyu-v027', 'imsingyu-v011'],
    hpScale: 1.15,
    profile: { healBelow: 0.6, lethalFirst: true, skillMinTargets: 0.5, skillAppetite: 0.85 },
    reward: { credits: 5, label: '에이스 격파 보상' }
  },
  {
    id: 'boss',
    name: '최종 보스',
    title: '압도적 화력',
    difficulty: 'boss',
    blurb: 'UR 한 장에 SSR 두 장. 남은 적이 한 명뿐이어도 스킬을 그대로 쏜다.',
    cards: ['imsingyu-v033', 'imsingyu-v028', 'imsingyu-v046'],
    hpScale: 1.25,
    profile: { healBelow: 0.45, lethalFirst: true, skillMinTargets: 0.34, skillAppetite: 1 },
    reward: { credits: 8, label: '보스 격파 보상' }
  }
];

export const DEFAULT_OPPONENT_ID = 'rookie';

/**
 * The opponent as it appears in one mode. Mode tuning scales combat stats (HP + ATK/DEF + AI +
 * credits) that replay and settlement both re-derive from the stored mode.
 */
export function opponentById(id: string, mode: BattleMode = 'normal'): Opponent | undefined {
  const base = OPPONENTS.find((opponent) => opponent.id === id);
  if (!base) return undefined;
  const tuning = MODE_TUNING[mode];
  return {
    ...base,
    hpScale: base.hpScale * tuning.hp,
    statScale: tuning.stat,
    profile: {
      ...base.profile,
      healBelow: base.profile.healBelow * tuning.heal,
      lethalFirst: base.profile.lethalFirst || tuning.ruthless,
      skillAppetite: Math.min(1, base.profile.skillAppetite * tuning.appetite)
    },
    reward: {
      ...base.reward,
      credits: base.reward.credits * MODE_CREDITS_MULTIPLIER[mode],
      label: mode === 'normal' ? base.reward.label : `${MODE_LABELS[mode]} · ${base.reward.label}`
    }
  };
}
