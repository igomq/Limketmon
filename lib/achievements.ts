// Achievement definitions and evaluation. Pure: the caller supplies counters.
export interface Achievement {
  id: string;
  name: string;
  description: string;
  reward: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_win', name: '첫 승리', description: '배틀에서 처음으로 승리했습니다.', reward: 2 },
  { id: 'wins_10', name: '10승 달성', description: '배틀에서 10번 승리했습니다.', reward: 5 },
  { id: 'boss_clear', name: '보스 격파', description: '보스 상대를 격파했습니다.', reward: 5 },
  { id: 'n_only_win', name: 'N등급의 반란', description: 'N 등급 카드만으로 승리했습니다.', reward: 4 },
  { id: 'clutch_win', name: '역전의 순간', description: '체력 10% 이하로 버틴 아군과 함께 승리했습니다.', reward: 4 },
  { id: 'all_rarities', name: '모든 등급 수집', description: 'N, R, SR, SSR, UR 등급을 모두 보유했습니다.', reward: 10 },
  { id: 'pulls_100', name: '100회 뽑기', description: '카드를 100번 뽑았습니다.', reward: 5 },
  { id: 'daily_3', name: '데일리 3회 클리어', description: '데일리 챌린지를 3번 클리어했습니다.', reward: 3 }
];

export interface AchievementProgress {
  wins: number;
  losses: number;
  bossClears: number;
  dailyClears: number;
  nOnlyWins: number;
  clutchWins: number;
  totalPulls: number;
  /** distinct rarities owned from inventory */
  ownedRarities: string[];
}

const ALL_RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'];

function satisfied(id: string, progress: AchievementProgress): boolean {
  switch (id) {
    case 'first_win':
      return progress.wins >= 1;
    case 'wins_10':
      return progress.wins >= 10;
    case 'boss_clear':
      return progress.bossClears >= 1;
    case 'n_only_win':
      return progress.nOnlyWins >= 1;
    case 'clutch_win':
      return progress.clutchWins >= 1;
    case 'all_rarities': {
      const owned = new Set(progress.ownedRarities);
      return ALL_RARITIES.every((rarity) => owned.has(rarity));
    }
    case 'pulls_100':
      return progress.totalPulls >= 100;
    case 'daily_3':
      return progress.dailyClears >= 3;
    default:
      return false;
  }
}

/** Ids currently satisfied, in ACHIEVEMENTS order. */
export function evaluateAchievements(progress: AchievementProgress): string[] {
  return ACHIEVEMENTS.filter((achievement) => satisfied(achievement.id, progress)).map(
    (achievement) => achievement.id
  );
}

export function achievementById(id: string): Achievement | undefined {
  return ACHIEVEMENTS.find((achievement) => achievement.id === id);
}

export function achievementClaimKey(id: string): string {
  return `achievement:${id}`;
}
