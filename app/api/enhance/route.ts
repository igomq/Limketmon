import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { enhanceCard, ensureUser, GameError } from '../../../lib/game';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('cardId' in body)) {
      return NextResponse.json({ error: '카드를 선택해주세요.' }, { status: 400 });
    }
    await ensureUser(user.userId, user.email);
    return NextResponse.json({ snapshot: await enhanceCard(user.userId, body.cardId) });
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Card enhance failed', error);
    return NextResponse.json({ error: '강화하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
