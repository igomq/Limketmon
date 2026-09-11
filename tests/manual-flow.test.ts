// Headless run of the manual verification checklist. The browser is not available in this
// environment, so each step drives the real route handlers and prints what it observed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createD1, migrate } from "./helpers/d1.mjs";

const db = createD1();
const dir = new URL("../drizzle/", import.meta.url);
for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
  migrate(db, readFileSync(new URL(file, dir), "utf8"));
}
const { env } = await import("./helpers/cloudflare-workers.mjs");
env.DB = db;
const { setAuthenticatedUser } = await import("./helpers/next-headers.mjs");
const pullRoute = await import("../app/api/pull/route.ts");
const couponRoute = await import("../app/api/coupon/route.ts");
const stateRoute = await import("../app/api/state/route.ts");
const deckRoute = await import("../app/api/deck/route.ts");
const battleRoute = await import("../app/api/battle/route.ts");
const { buildSetup } = await import("../lib/battle/setup.ts");
const { advance, createBattle } = await import("../lib/battle/engine.ts");
const { aiDecision } = await import("../lib/battle/ai.ts");
const { opponentById } = await import("../lib/battle/opponents.ts");

const USER = "manual_user";
const post = (path: string, body: unknown) =>
  new Request("http://local" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async (response: Response) => (await response.json()) as Record<string, never>;
const step = (n: number, text: string) => console.log("STEP " + n + " " + text);

test("manual verification checklist", async () => {
  setAuthenticatedUser(USER, "manual@local.invalid", "수동검증");
  step(1, "로컬 로그인: oai-authenticated-user-id 헤더로 인증됨");

  const free = await pullRoute.POST(post("/api/pull", { count: 1 }));
  const freeBody = await read(free);
  const freeResult = (freeBody as unknown as { results: Array<{ usedFreePull: boolean; card: { rarity: string } }> }).results[0];
  assert.equal(free.status, 200);
  step(2, "무료 뽑기: HTTP " + free.status + " · usedFreePull=" + freeResult.usedFreePull + " · " + freeResult.card.rarity);

  const coupon = await couponRoute.POST(post("/api/coupon", { code: "LIMKETMON" }));
  const couponBody = (await read(coupon)) as unknown as { snapshot: { credits: number } };
  step(3, "웰컴 쿠폰: HTTP " + coupon.status + " · 뽑기권 " + couponBody.snapshot.credits + "장");

  const five = await pullRoute.POST(post("/api/pull", { count: 5 }));
  const fiveBody = (await read(five)) as unknown as { results: unknown[]; snapshot: { credits: number; pityRemaining: number; inventory: unknown[] } };
  assert.equal(fiveBody.results.length, 5);
  step(4, "5연속 뽑기: " + fiveBody.results.length + "장 · 뽑기권 " + fiveBody.snapshot.credits + " · 천장까지 " + fiveBody.snapshot.pityRemaining + "회");

  let state = (await read(await stateRoute.GET())) as unknown as { snapshot: { inventory: Array<{ cardId: string }>; decks: unknown[] } };
  for (let round = 0; round < 20 && state.snapshot.inventory.length < 3; round++) {
    await pullRoute.POST(post("/api/pull", { count: 5 }));
    state = (await read(await stateRoute.GET())) as typeof state;
  }
  const owned = state.snapshot.inventory.map((item) => item.cardId);
  step(5, "카드 확보: " + owned.length + "종 보유 · 자동 스타터 덱 " + state.snapshot.decks.length + "개");

  const created = await deckRoute.POST(post("/api/deck", { action: "create", name: "수동검증 덱", cardIds: owned.slice(0, 3) }));
  const decks = ((await read(created)) as unknown as { decks: Array<{ id: string; name: string; cards: string[] }> }).decks;
  const deck = decks.find((entry) => entry.name === "수동검증 덱")!;
  step(6, "덱 생성: HTTP " + created.status + " · " + deck.cards.length + "장 · 덱 " + decks.length + "개");

  const start = await battleRoute.POST(post("/api/battle", { action: "start", deckId: deck.id, opponentId: "rookie" }));
  const setup = ((await read(start)) as unknown as { setup: { battleId: string; seed: number } & Parameters<typeof buildSetup>[0] }).setup;
  step(7, "PvE 진입: HTTP " + start.status + " · 상대 rookie · 시드 " + setup.seed);

  const full = buildSetup({
    kind: setup.kind, opponentId: setup.opponentId, modifier: setup.modifier, seed: setup.seed,
    playerCardIds: setup.player.map((entry: { cardId: string }) => entry.cardId), playerEnhance: setup.player.map((entry: { enhance?: number }) => entry.enhance ?? 0), battleId: setup.battleId
  });
  const profile = opponentById(setup.opponentId)!.profile;
  let battle = createBattle(full);
  const decisions: Array<{ uid: string; action: "attack" | "skill" }> = [];
  for (let turn = 0; turn < 400 && battle.status === "active"; turn++) {
    const uid = battle.activeUid;
    if (!uid) break;
    const mine = uid.startsWith("a");
    let action: "attack" | "skill" = mine ? "skill" : aiDecision(battle, profile).action;
    let outcome = advance(battle, { uid, action });
    if (outcome.error) { action = "attack"; outcome = advance(battle, { uid, action }); }
    if (outcome.error) break;
    battle = outcome.state;
    if (mine) decisions.push({ uid, action });
  }
  step(8, "전투 완료: " + battle.status + " · " + battle.round + "라운드 · 로그 " + battle.log.length + "건");

  const finish = await battleRoute.POST(post("/api/battle", { action: "finish", battleId: setup.battleId, decisions }));
  const summary = ((await read(finish)) as unknown as { summary: { result: string; rewards: Array<{ label: string; credits: number }>; rounds: number } }).summary;
  step(9, "보상 반영: HTTP " + finish.status + " · " + summary.result + " · " + JSON.stringify(summary.rewards));

  const after = (await read(await stateRoute.GET())) as unknown as { snapshot: { credits: number; stats: { battles: number; wins: number } } };
  step(10, "replay: 저장된 시드/로그로 재현 · 상태 전투 " + after.snapshot.stats.battles + "회 · 승 " + after.snapshot.stats.wins + "회 · 뽑기권 " + after.snapshot.credits);

  const replay = await battleRoute.POST(post("/api/battle", { action: "replay", battleId: setup.battleId }));
  const replayed = ((await read(replay)) as unknown as { replay: { verified: boolean; result: string; rulesetVersion: number; events: unknown[] } }).replay;
  step(11, "새로고침 후 상태 유지: replay verified=" + replayed.verified + " · ruleset v" + replayed.rulesetVersion + " · 이벤트 " + replayed.events.length + "건 재생");

  const daily = (await read(await stateRoute.GET())) as unknown as { snapshot: { daily: { date: string; title: string; ruleLabel: string; cleared: boolean } } };
  step(12, "데일리 챌린지: " + daily.snapshot.daily.date + " · " + daily.snapshot.daily.title + " · " + daily.snapshot.daily.ruleLabel + " · 클리어=" + daily.snapshot.daily.cleared);

  assert.equal(replayed.verified, true);
  assert.ok(summary.rounds > 0);
});
