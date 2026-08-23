import { ServiceError } from '$lib/server/errors.ts';
import type { Repositories } from '$lib/server/repositories/types.ts';

export const COUPONS: Record<string, number> = {
	LIMKETMON: 100
};

export function normalizeCode(raw: string): string {
	return raw.trim().toUpperCase();
}

export async function redeemCoupon(
	repos: Repositories,
	userId: string,
	rawCode: string
): Promise<{ code: string; credits: number }> {
	const code = normalizeCode(rawCode);
	if (!code) throw new ServiceError('empty_code', '쿠폰 코드를 입력하세요.');

	const credits = COUPONS[code];
	if (credits === undefined) throw new ServiceError('invalid_code', '유효하지 않은 쿠폰 코드입니다.');

	if (await repos.game.hasRedeemedCoupon(userId, code)) {
		throw new ServiceError('already_redeemed', '이미 사용한 쿠폰입니다.');
	}

	await repos.game.redeemCoupon(userId, code, credits, new Date().toISOString());
	return { code, credits };
}
