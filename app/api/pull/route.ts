import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, GameError, pullCards } from '../../../lib/game';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '뽑기 수량을 확인해주세요.' }, { status: 400 });
    }
    const count = 'count' in body ? body.count : 1;
    if (count !== 1 && count !== 5) {
      return NextResponse.json({ error: '1회 또는 5연속 뽑기만 가능합니다.' }, { status: 400 });
    }
    await ensureUser(user.userId, user.email);
    return NextResponse.json(await pullCards(user.userId, count));
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Card pull failed', error);
    return NextResponse.json({ error: '결과를 확인하지 못했어요. 도감을 확인한 뒤 다시 시도해주세요.' }, { status: 503 });
  }
}
