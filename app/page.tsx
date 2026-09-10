import { getChatGPTUser } from './chatgpt-auth';
import Game from './game';
import { cards, emptySnapshot, ensureUser, getSnapshot } from '../lib/game';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) {
    return <Game user={null} cards={cards} initial={emptySnapshot()} />;
  }

  await ensureUser(user.userId, user.email);
  const snapshot = await getSnapshot(user.userId);
  return <Game user={{ email: user.email, displayName: user.displayName }} cards={cards} initial={snapshot} />;
}
