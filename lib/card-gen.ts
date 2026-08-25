/**
 * Deterministic card metadata generation.
 * Pure module — no fs, no time, no Math.random. Everything is derived from a seed
 * (the source image filename), so `cards:sync` is idempotent per image.
 */
import type { Card } from './cards.ts';
import type { Rarity } from './rules.ts';

export function hashSeed(str: string): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SKILLS: Array<[string, string]> = [
	['급식실 선턴 확보', '개점과 동시에 최전열에 도달한다. 선턴이 아닐 경우 발동하지 않는다.'],
	['매점 골든타임', '하교 직후 3분 동안 매점 재고 스캔 속도가 두 배가 된다.'],
	['야자 탈출 프로토콜', '감시망의 사각을 계산해 조용히 사라진다. 성공률은 컨디션에 비례.'],
	['시험기간 각성', '시험 30분 전 머리 회전이 급상승한다. 부작용: 시험 후 급락.'],
	['무한 지각 회피', '교문에 들어서는 순간 쉬는 시간으로 인식시킨다. 1일 1회.'],
	['교실 순간이동', '종치기 직전 자리에 착석한다. 이동 경로는 관측되지 않는다.'],
	['현금성 스웩 +30', '소지품 잔여 현금에 비례해 존재감이 상승한다.'],
	['수행평가 긴급회피', '발표 순번을 평균 4칸 뒤로 미룬다. 눈치 소모 큼.'],
	['에너지드링크 오버클럭', '60분간 공격력이 1.5배. 이후 필연적으로 다운된다.'],
	['체육복 파워 오버로드', '체육 시간 한정 방어력이 크게 상승한다. 실내화는 못 찾는다.'],
	['안경 닦기 집중', '렌즈가 완전히 깨끗해지는 동안 주변 소음이 차단된다.'],
	['필통 뒤지기 랜덤 인카운터', '필통에서 예상 못한 물건을 발견해 행운이 미세하게 상승한다.'],
	['소항 버스 정면 승차', '가장 좋은 자리를 확률적으로 선점한다. 뒷문 리스크 있음.'],
	['자습시간 초월', '꿈도 희망도 없는 정적 속에서 의식을 유지한다.'],
	['충전기 케이블 지배', '교실 유일의 케이블에 대한 지배권을 1시간 획득한다.'],
	['빵셔틀 역제동', '심부름 요청을 역으로 활용해 추가 간식을 획득한다.'],
	['청바지 주머니 차원수납', '주머니 하나에 필요 이상의 물건을 저장한다. 무게는 증발.'],
	['오답노트 회귀', '같은 실수를 3번 하면 해당 유형 문제에 저항을 얻는다.']
];

const FLAVORS = [
	'"오늘 급식 파인애플 나온다며?"',
	'"야자 끝나고 소항 앞에서 보자."',
	'"이 카드의 진정한 가치는 회수 불가능한 청춘이다."',
	'"수집가들 사이에서 전설로 회자되는 희귀 개체."',
	'"전학 전 설명할 수 없는 기운이 감돌고 있었다고 한다."',
	'"카드 뒷면에 연필 자국이 남아 있다."',
	'"첫 판매 기록은 매점 삼각김밥 두 개였다."',
	'"희귀도보다 구도가 아까운 순간."',
	'"사진 찍힌 사람 본인은 이 카드의 존재를 모른다."',
	'"한정판이 아니라 그냥 한정된 순간."'
];

const ALIASES = [
	'평범한 일상',
	'굳은날의 기록',
	'점심시간의 지배자',
	'복도의 스나이퍼',
	'매점의 미학',
	'교실의 관찰자',
	'소항의 아이콘',
	'탈주의 달인',
	'졸지 않는 자',
	'전설의 한 컷',
	'침묵의 카리스마',
	'미소의 역설'
];

const RARITY_ROLLS: Array<{ rarity: Rarity; max: number }> = [
	{ rarity: 'N', max: 0.5 },
	{ rarity: 'R', max: 0.77 },
	{ rarity: 'SR', max: 0.91 },
	{ rarity: 'SSR', max: 0.98 },
	{ rarity: 'UR', max: 1.01 }
];

const STAT_BONUS: Record<Rarity, number> = { N: 0, R: 300, SR: 700, SSR: 1200, UR: 2000 };

/** Assign a rarity from a uniform roll in [0,1). */
export function rarityFromRoll(roll: number): Rarity {
	for (const { rarity, max } of RARITY_ROLLS) {
		if (roll < max) return rarity;
	}
	return 'N';
}

export interface GenerateCardInput {
	version: number;
	imageKey: string;
	/** original source filename, used as the seed */
	sourceName: string;
}

export function generateCard({ version, imageKey, sourceName }: GenerateCardInput): Card {
	const rand = mulberry32(hashSeed(sourceName));
	const rarity = rarityFromRoll(rand());

	const skill = SKILLS[Math.floor(rand() * SKILLS.length)]!;
	const flavor = FLAVORS[Math.floor(rand() * FLAVORS.length)]!;
	const alias = ALIASES[Math.floor(rand() * ALIASES.length)]!;

	const bonus = STAT_BONUS[rarity];
	const stat = (base: number, spread: number) => 100 + base + Math.floor(rand() * spread) + bonus;

	return {
		id: `imsingyu-v${String(version).padStart(3, '0')}`,
		version,
		name: `임신규-v${String(version).padStart(3, '0')} · ${alias}`,
		rarity,
		imageKey,
		skillName: skill[0],
		skillDescription: skill[1],
		flavorText: flavor,
		attack: stat(200, 400),
		defense: stat(150, 350),
		luck: Math.floor(rand() * 100) + (rarity === 'UR' ? 50 : rarity === 'SSR' ? 30 : 10)
	};
}

/**
 * Within a single sync batch, guarantee every rarity that can exist (batch >= 5 cards)
 * is represented at least once, by promoting the highest-roll cards that are closest
 * to the missing thresholds. Deterministic for a fixed input set.
 */
export function ensureRarityCoverage(cards: Card[]): void {
	if (cards.length < 5) return;
	const order: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR'];
	const missing = order.filter((r) => !cards.some((c) => c.rarity === r));
	if (missing.length === 0) return;

	// promote from the top: strongest N-card becomes the weakest missing rarity, etc.
	const rank = (r: Rarity) => order.indexOf(r);
	const sorted = [...cards].sort((a, b) => rank(a.rarity) - rank(b.rarity) || b.attack - a.attack);
	let cursor = sorted.length - 1;
	for (const target of [...missing].reverse()) {
		// find the strongest card whose rarity is below target
		while (cursor >= 0 && rank(sorted[cursor]!.rarity) >= rank(target)) cursor--;
		if (cursor < 0) break;
		const card = sorted[cursor]!;
		card.rarity = target;
	}
}
