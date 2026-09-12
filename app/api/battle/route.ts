import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, finishBattle, GameError, replayBattle, startBattle } from '../../../lib/game';

// The server owns the seed, the deck snapshot, the opponent and the rewards. The client only
// sends a deck id plus the action log it played, which is re-simulated before anything is paid.
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('action' in body)) {
      return NextResponse.json({ error: '요청을 확인해주세요.' }, { status: 400 });
    }
    const payload = body as { action?: unknown; deckId?: unknown; opponentId?: unknown; kind?: unknown; mode?: unknown; battleId?: unknown; decisions?: unknown; rewardTicketType?: unknown };
    await ensureUser(user.userId, user.email);
    switch (payload.action) {
      case 'start': {
        const setup = await startBattle(user.userId, {
          deckId: payload.deckId,
          opponentId: payload.opponentId,
          kind: payload.kind,
          mode: payload.mode
        });
        return NextResponse.json({ setup });
      }
      case 'finish': {
        if (typeof payload.battleId !== 'string') {
          return NextResponse.json({ error: '전투를 찾을 수 없습니다.' }, { status: 400 });
        }
        return NextResponse.json({ summary: await finishBattle(user.userId, payload.battleId, payload.decisions, new Date(), payload.rewardTicketType) });
      }
      case 'replay': {
        if (typeof payload.battleId !== 'string') {
          return NextResponse.json({ error: '전투를 찾을 수 없습니다.' }, { status: 400 });
        }
        return NextResponse.json({ replay: await replayBattle(user.userId, payload.battleId) }, {
          headers: { 'Cache-Control': 'private, no-store' }
        });
      }
      default:
        return NextResponse.json({ error: '지원하지 않는 요청입니다.' }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Battle request failed', error);
    return NextResponse.json({ error: '전투를 처리하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
