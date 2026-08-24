import { getChatGPTUser } from './chatgpt-auth';
import Game from './game';
import { cards, ensureUser, getSnapshot } from '../lib/game';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getChatGPTUser();
  if (!user) {
    return (
      <main className="signin-shell">
        <section className="signin-panel panel">
          <h1>LIMKETMON</h1>
          <p>임신규 사진 카드를 뽑고 나만의 도감을 완성하세요.</p>
          <a className="btn btn-primary" href="/signin-with-chatgpt?return_to=%2F">
            ChatGPT로 시작하기
          </a>
        </section>
      </main>
    );
  }

  await ensureUser(user.userId, user.email);
  const snapshot = await getSnapshot(user.userId);
  return <Game user={{ email: user.email, displayName: user.displayName }} cards={cards} initial={snapshot} />;
}
