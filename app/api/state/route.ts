import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getSnapshot } from '../../../lib/game';

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  return NextResponse.json({ snapshot: await getSnapshot(user.userId) }, {
    headers: { 'Cache-Control': 'private, no-store' }
  });
}
