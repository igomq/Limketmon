import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { autoDeck, createDeck, deleteDeck, ensureUser, GameError, listDecks, renameDeck, saveDeck, setDefaultDeck } from '../../../lib/game';

// Every action is scoped to the signed-in user; deck ids from the body are only ever used
// together with that user id, so one account cannot read or edit another account's decks.
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  await ensureUser(user.userId, user.email);
  return NextResponse.json({ decks: await listDecks(user.userId) }, {
    headers: { 'Cache-Control': 'private, no-store' }
  });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('action' in body)) {
      return NextResponse.json({ error: '요청을 확인해주세요.' }, { status: 400 });
    }
    const payload = body as { action?: unknown; deckId?: unknown; name?: unknown; cardIds?: unknown };
    await ensureUser(user.userId, user.email);
    const deckId = typeof payload.deckId === 'string' ? payload.deckId : '';
    let decks;
    switch (payload.action) {
      case 'create':
        decks = await createDeck(user.userId, payload.name, payload.cardIds);
        break;
      case 'rename':
        if (!deckId) throw new GameError('invalid_deck', '덱을 선택해주세요.');
        decks = await renameDeck(user.userId, deckId, payload.name);
        break;
      case 'delete':
        if (!deckId) throw new GameError('invalid_deck', '덱을 선택해주세요.');
        decks = await deleteDeck(user.userId, deckId);
        break;
      case 'setDefault':
        if (!deckId) throw new GameError('invalid_deck', '덱을 선택해주세요.');
        decks = await setDefaultDeck(user.userId, deckId);
        break;
      case 'auto':
        decks = await autoDeck(user.userId, deckId || undefined);
        break;
      case 'save':
        if (!deckId) throw new GameError('invalid_deck', '덱을 선택해주세요.');
        decks = await saveDeck(user.userId, deckId, payload.cardIds);
        break;
      default:
        return NextResponse.json({ error: '지원하지 않는 요청입니다.' }, { status: 400 });
    }
    return NextResponse.json({ decks });
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Deck request failed', error);
    return NextResponse.json({ error: '덱을 저장하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
