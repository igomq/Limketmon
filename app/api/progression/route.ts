import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ensureUser, GameError } from '../../../lib/game';
import { applyProgression } from '../../../lib/progression-server';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  try {
    // Bound streamed bytes too: Content-Length is optional and untrusted.
    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ error: '요청이 비어 있습니다.' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) {
          await reader.cancel();
          return NextResponse.json({ error: '요청이 너무 큽니다.' }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 }); }
    if (!(body && typeof body === 'object' && 'preview' in body && body.preview === true)) await ensureUser(user.userId, user.email);
    return NextResponse.json(await applyProgression(user.userId, body));
  } catch (error) {
    if (error instanceof GameError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    console.error('Progression failed', error);
    return NextResponse.json({ error: '처리하지 못했어요. 잠시 후 다시 시도해주세요.' }, { status: 503 });
  }
}
