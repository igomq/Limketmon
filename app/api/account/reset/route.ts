import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { resetAccount } from '../../../../lib/game';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || request.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ error: '사이트에서 다시 시도해주세요.' }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('confirmation' in body) || body.confirmation !== '초기화') {
    return NextResponse.json({ error: '확인란에 초기화를 입력해주세요.' }, { status: 400 });
  }
  try {
    return NextResponse.json({ snapshot: await resetAccount(user.userId) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Account reset failed', error);
    return NextResponse.json({ error: '초기화하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
