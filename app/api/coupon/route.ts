import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, GameError, redeemCoupon } from '../../../lib/game';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code !== 'string') {
      return NextResponse.json({ error: '쿠폰 코드를 입력하세요.' }, { status: 400 });
    }
    await ensureUser(user.userId, user.email);
    return NextResponse.json({ snapshot: await redeemCoupon(user.userId, body.code) });
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
