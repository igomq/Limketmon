import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, GameError, pullCard } from '../../../lib/game';

export async function POST() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    await ensureUser(user.userId, user.email);
    return NextResponse.json(await pullCard(user.userId));
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
