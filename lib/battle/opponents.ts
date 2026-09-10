// Five curated PvE opponents. Difficulty is deck composition + AI profile + hpScale,
// never HP alone: rookie runs three N cards at reduced HP, boss runs the highest rarities.
import type { Opponent } from './types.ts';

export const OPPONENTS: Opponent[] = [
  {
    id: 'rookie',
    name: '루키 조교',
    title: '첫 대련',
    difficulty: 'beginner',
    blurb: '연습용 카드 세 장. 스킬을 아껴 쓰고 힐을 자주 넣는다. 세 장의 N/R 덱이면 충분히 이긴다.',
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

export function opponentById(id: string): Opponent | undefined {
  return OPPONENTS.find((opponent) => opponent.id === id);
}
