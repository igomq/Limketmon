import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, GameError, redeemCoupon } from '../../../lib/game';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' || body.code.length > 64) {
      return NextResponse.json({ error: '쿠폰 코드를 입력하세요.' }, { status: 400 });
    }
    await ensureUser(user.userId, user.email);
    return NextResponse.json({ snapshot: await redeemCoupon(user.userId, body.code) });
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Coupon redemption failed', error);
    return NextResponse.json({ error: '쿠폰을 확인하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
