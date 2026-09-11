import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test, { after } from 'node:test';
import { createD1, migrate } from './helpers/d1.mjs';
import { env } from './helpers/cloudflare-workers.mjs';
import { setAuthenticatedUser } from './helpers/next-headers.mjs';
import { parseDeckSlots } from '../lib/enhance.ts';
import { traitCost } from '../lib/progression.ts';
import { buildSetup } from '../lib/battle/setup.ts';
import { createBattle, advance } from '../lib/battle/engine.ts';
import { aiDecision } from '../lib/battle/ai.ts';
import { opponentById } from '../lib/battle/opponents.ts';
import { BATTLE_RULESET_VERSION, type BattleMode, type Decision } from '../lib/battle/types.ts';
import { DAILY_REWARD_CREDITS } from '../lib/daily.ts';

const dir = new URL('../drizzle/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const sqlOf = (f: string) => readFileSync(new URL(f, dir), 'utf8');
const db = createD1();
for (const f of files) migrate(db, sqlOf(f));
env.DB = db;
const game = await import('../lib/game.ts');
const { applyProgression } = await import('../lib/progression-server.ts');
const route = await import('../app/api/progression/route.ts');
after(() => db.close());
let sequence = 0;
async function user() {
  const id = `storage-${++sequence}`;
  await game.ensureUser(id, `${id}@local.invalid`);
  // Suppress automatic starter creation so consumption tests control their decks explicitly.
  db.prepare("INSERT INTO decks VALUES (?, ?, 'test', 1, 'now', 'now')").bind(id, id).run();
  return id;
}
const card = (rarity: string, n = 0) => game.cards.filter((c) => c.rarity === rarity)[n]!;
function own(u: string, rarity = 'N', quantity = 5, level = 0, traits: unknown[] = [], ownedId = card(rarity).id, base = card(rarity).id) {
  db.prepare("INSERT INTO inventory (user_id,card_id,quantity,first_obtained_at,enhance_level,traits,base_card_id,rarity_override) VALUES (?,?,?,'now',?,?,?,?)")
    .bind(u, ownedId, quantity, level, JSON.stringify(traits), ownedId === base ? null : base, ownedId === base ? null : rarity).run();
  return ownedId;
}
const row = (u: string, id: string) => db.prepare('SELECT * FROM inventory WHERE user_id=? AND card_id=?').bind(u,id).first();
const state = (u: string) => db.prepare('SELECT * FROM user_game_state WHERE user_id=?').bind(u).first();
const balances = (u: string, proof=1000, fragments=5, twin=5) => db.prepare('UPDATE user_game_state SET proof=?,fragments=?,twin_proof=? WHERE user_id=?').bind(proof,fragments,twin,u).run();
const trait = (level=10, transcended=false) => ({ id: 'damage', level, transcended });
const dismantle = (u: string, id: string, quantity: number) => applyProgression(u, {action:'dismantle', cards:[{cardId:id,quantity}]});
const trans = (u: string,id: string) => applyProgression(u,{action:'transcend',cardId:id,traitId:'damage'});
const dump = (u: string) => JSON.stringify([state(u), db.prepare('SELECT * FROM inventory WHERE user_id=? ORDER BY card_id').bind(u).all().results]);

 test('upgrade preserves existing enhancement, quantities, coupons, decks and migration metadata', () => {
  const old = createD1();
  try {
    for (const f of files.filter((f) => f < '0004')) migrate(old,sqlOf(f));
    old.exec("INSERT INTO users VALUES ('old','old@x','then','then'); INSERT INTO user_game_state (user_id,pull_credits,sr_tickets,ssr_tickets) VALUES ('old',42,3,4); INSERT INTO inventory VALUES ('old','base',7,'then',9); INSERT INTO coupon_redemptions VALUES ('old','LIMKETMON','then'); INSERT INTO decks VALUES ('deck','old','kept',1,'then','then'); INSERT INTO deck_cards VALUES ('deck',0,'base')");
    for (const f of files.filter((f) => f >= '0004')) migrate(old,sqlOf(f));
    const kept = old.prepare('SELECT * FROM inventory').first();
    assert.equal(kept.quantity,7); assert.equal(kept.enhance_level,9); assert.equal(kept.traits,'[]'); assert.equal(kept.base_card_id,null);
    assert.equal(old.prepare('SELECT * FROM coupon_redemptions').first().coupon_code,'LIMKETMON');
    assert.equal(old.prepare('SELECT * FROM deck_cards').first().card_id,'base');
    assert.equal(old.prepare('SELECT * FROM user_game_state').first().pull_credits,42);
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json',dir),'utf8'));
    assert.deepEqual(journal.entries.map((e: {tag:string})=>e.tag+'.sql'),files);
    const snapshot = JSON.parse(readFileSync(new URL('meta/0004_snapshot.json',dir),'utf8'));
    for (const table of ['inventory','user_game_state']) {
      const actual = old.prepare(`PRAGMA table_info(${table})`).all().results.map((r: {name:string})=>r.name).sort();
      assert.deepEqual(Object.keys(snapshot.tables[table].columns).sort(),actual);
    }
  } finally { old.close(); }
});

test('all balances reject negative UPDATE and INSERT, retaining old ticket guards', async () => {
  const u = await user();
  for (const column of ['proof','fragments','twin_proof','low_tickets','sr_tickets','ssr_tickets','pull_credits']) {
    assert.throws(()=>db.prepare(`UPDATE user_game_state SET ${column}=-1 WHERE user_id=?`).bind(u).run());
    db.prepare('DELETE FROM user_game_state WHERE user_id=?').bind(u).run();
    assert.throws(()=>db.prepare(`INSERT INTO user_game_state (user_id,${column}) VALUES (?,-1)`).bind(u).run(), column);
    db.prepare('INSERT INTO user_game_state (user_id) VALUES (?)').bind(u).run();
  }
});

test('API auth, malformed JSON, streamed size limit, strict inputs and foreign ownership', async () => {
  const u=await user(), other=await user(), id=own(other);
  const request=(body: string)=>new Request('http://local/api/progression',{method:'POST',body});
  setAuthenticatedUser(null);
  assert.equal((await route.POST(request('{}'))).status,401);
  setAuthenticatedUser(u);
  assert.equal((await route.POST(request('{'))).status,400);
  assert.equal((await route.POST(request(' '.repeat(65537)))).status,413);
  for (const body of [null,[],{action:'unknown'},{action:'trait',cardId:id,traitId:'damage'},{action:'craft-twin',preview:'true'}])
    assert.equal((await route.POST(request(JSON.stringify(body)))).status,400);
  const local=own(u);
  for (const quantity of [-1,0,1.5,NaN,Infinity,6,'1']) await assert.rejects(()=>dismantle(u,local,quantity as number));
  await assert.rejects(()=>applyProgression(u,{action:'dismantle',cards:[{cardId:local,quantity:1},{cardId:local,quantity:1}]}));
  assert.equal(row(u,local).quantity,5); assert.equal(row(other,id).quantity,5);
});

test('preview and bulk boundaries never write; UR dismantle pays exact guaranteed fragments', async () => {
  const u=await user(), n=own(u,'N',3,2), r=own(u,'R',4,1), ur=own(u,'UR',2);
  const before=dump(u);
  const preview=await applyProgression(u,{action:'bulk-dismantle',rarity:'N',maxEnhance:2,includeBase:false,preview:true});
  assert.deepEqual(preview.preview.cards,[{cardId:n,quantity:2}]); assert.equal(dump(u),before);
  await assert.rejects(()=>applyProgression(u,{action:'bulk-dismantle',rarity:'N',maxEnhance:1,includeBase:true,preview:true}));
  await assert.rejects(()=>applyProgression(u,{action:'bulk-dismantle',rarity:'N',maxEnhance:2,includeBase:true}));
  await dismantle(u,ur,2); assert.equal(state(u).proof,50); assert.equal(state(u).fragments,2); assert.equal(row(u,ur),null); assert.equal(row(u,r).quantity,4);
});

test('invalid multi-row selection consumes nothing and protects last deployed copy',async()=>{
  const u=await user(), id=own(u), r=own(u,'R');
  const before=dump(u);
  await assert.rejects(()=>applyProgression(u,{action:'dismantle',cards:[{cardId:id,quantity:1},{cardId:r,quantity:6}]}));
  assert.equal(dump(u),before);
  db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u,id).run();
  await assert.rejects(()=>dismantle(u,id,5)); await dismantle(u,id,4); await assert.rejects(()=>dismantle(u,id,1));
  assert.equal(row(u,id).quantity,1);
});

test('stale second row and newly deployed card roll back preceding batch writes',async()=>{
  for(const deployment of [false,true]) {
    const u=await user(), a=own(u), b=own(u,'R');
    const batch=db.batch.bind(db); let injected=false;
    db.batch=async(statements)=>{
      if(!injected && statements.some((s)=>s.query.includes('DELETE FROM inventory'))) {
        injected=true;
        if(deployment) db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u,b).run();
        else db.prepare('UPDATE inventory SET quantity=quantity+1 WHERE user_id=? AND card_id=?').bind(u,b).run();
      }
      return batch(statements);
    };
    try {await assert.rejects(()=>applyProgression(u,{action:'dismantle',cards:[{cardId:a,quantity:5},{cardId:b,quantity:5}]}));}
    finally {db.batch=batch;}
    assert.ok(injected); assert.equal(row(u,a).quantity,5); assert.equal(row(u,b).quantity,deployment?5:6); assert.equal(state(u).proof,0);
  }
});

test('concurrent dismantles cannot overconsume or double pay',async()=>{
  const u=await user(), id=own(u,'UR',2);
  const results=await Promise.allSettled([dismantle(u,id,2),dismantle(u,id,2)]);
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1); assert.equal(state(u).proof,50); assert.equal(state(u).fragments,2);
});

test('trait costs, two-slot concurrency, level cap and insufficient proof rollback',async()=>{
  const u=await user(), id=own(u); balances(u,0);
  const request=(traitId:string)=>applyProgression(u,{action:'trait',cardId:id,traitId});
  await assert.rejects(()=>request('damage')); assert.equal(row(u,id).traits,'[]');
  balances(u,1000);
  const results=await Promise.allSettled(['damage','synergy','resist_fire'].map(request));
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);
  await request('synergy'); await assert.rejects(()=>request('resist_fire'));
  for(const level of [4,9,19,20]) {
    db.prepare('UPDATE inventory SET traits=? WHERE user_id=? AND card_id=?').bind(JSON.stringify([trait(level)]),u,id).run();
    const before=state(u).proof;
    if(level===20) await assert.rejects(()=>request('damage'));
    else {await request('damage');assert.equal(state(u).proof,before-traitCost('N',level));assert.equal(JSON.parse(row(u,id).traits)[0].level,level+1);}
  }
});

test('craft twin consumes exactly five fragments and concurrent requests cannot overdraw',async()=>{
  const u=await user(); balances(u,0,5,0);
  const results=await Promise.allSettled([applyProgression(u,{action:'craft-twin'}),applyProgression(u,{action:'craft-twin'})]);
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1); assert.equal(state(u).fragments,0); assert.equal(state(u).twin_proof,1);
});

test('transcend splits one copy, preserves all progress, and moves a singleton deck reference',async()=>{
  for(const quantity of [1,3]) {
    const u=await user(), traits=[trait(),{id:'synergy',level:7,transcended:false}], id=own(u,'SSR',quantity,5,traits); balances(u);
    db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u,id).run();
    const result=await trans(u,id); assert.ok(result.cardId);
    const output=row(u,result.cardId); assert.equal(output.rarity_override,'UR'); assert.equal(output.enhance_level,5); assert.equal(output.quantity,1);
    assert.deepEqual(JSON.parse(output.traits),[{...trait(),transcended:true,spentProof:quantity===1?400:0,...(quantity>1?{refundEstimated:false}:{})},{...traits[1],spentProof:quantity===1?190:0,...(quantity>1?{refundEstimated:false}:{})}]); assert.equal(state(u).twin_proof,4);
    assert.equal(row(u,id)?.quantity ?? 0,quantity-1);
    assert.equal(db.prepare('SELECT card_id FROM deck_cards WHERE deck_id=?').bind(u).first().card_id,quantity===1?result.cardId:id);
    if(quantity>1) assert.deepEqual(JSON.parse(row(u,id).traits),[{...traits[0],spentProof:400},{...traits[1],spentProof:190}]);
  }
});

test('transcend thresholds, XR cap, repeated trait and missing currency refuse atomically',async()=>{
  for(const [rarity,level,tl,done,twin] of [['SSR',4,10,false,1],['SSR',5,9,false,1],['XR',5,10,false,1],['UR',5,10,true,1],['UR',5,10,false,0]] as const) {
    const u=await user(), id=own(u,rarity,2,level,[trait(tl,done)],crypto.randomUUID(),card('UR').id);balances(u,0,0,twin);
    const before=dump(u);await assert.rejects(()=>trans(u,id));assert.equal(dump(u),before);
  }
  const u=await user(),id=own(u,'UR',2,5,[trait()]);balances(u,0,0,1);
  const results=await Promise.allSettled([trans(u,id),trans(u,id)]);
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal(state(u).twin_proof,0);
  assert.equal((await game.ownedRows(u)).filter((r)=>r.rarity_override==='XR').length,1);
});

test('fusion resets output and excludes all input base kinds without merging enhanced stacks',async()=>{
  const u=await user();
  for(const c of game.cards.filter((c)=>c.rarity==='N')) own(u,'N',4,8,[trait()],c.id,c.id);
  const a=card('N').id,b=card('N',1).id;
  const result=await applyProgression(u,{action:'fuse',count:2,cards:[{cardId:a,quantity:1},{cardId:b,quantity:1}]});
  const output=row(u,result.cardId);assert.ok(![a,b].includes(output.base_card_id));assert.equal(output.enhance_level,0);assert.equal(output.traits,'[]');assert.equal(output.quantity,1);
  assert.equal(row(u,output.base_card_id).enhance_level,8);assert.equal(row(u,output.base_card_id).quantity,4);
  assert.equal(row(u,a).quantity,3);assert.equal(row(u,b).quantity,3);
});

test('fusion validates same grade, count, minimum enhance, UR/XR prohibition and deck protection',async()=>{
  for(const [rarity,level,count,ok] of [['SR',0,3,false],['SR',1,3,true],['SSR',1,3,false],['SSR',2,3,true],['UR',5,3,false],['XR',5,2,false]] as const){
    const u=await user(),id=own(u,rarity,4,level,[],crypto.randomUUID(),card('N').id),before=dump(u);
    const call=()=>applyProgression(u,{action:'fuse',count,cards:[{cardId:id,quantity:count}]});
    if(ok){const result=await call();assert.equal(row(u,result.cardId).enhance_level,0);assert.equal(row(u,id).quantity,4-count);}
    else {await assert.rejects(call);assert.equal(dump(u),before);}
  }
  const u=await user(),a=own(u),b=own(u,'R'); const before=dump(u);
  for(const cards of [[{cardId:a,quantity:1},{cardId:b,quantity:1}],[{cardId:a,quantity:3}]]) await assert.rejects(()=>applyProgression(u,{action:'fuse',count:2,cards}));
  assert.equal(dump(u),before);
  db.prepare('UPDATE inventory SET quantity=3 WHERE user_id=? AND card_id=?').bind(u,a).run();
  db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u,a).run();
  await assert.rejects(()=>applyProgression(u,{action:'fuse',count:3,cards:[{cardId:a,quantity:3}]}));
});

test('public coupon concurrent receipt and hidden repeated all-catalog grant preserve enhancement',async()=>{
  const u=await user(),id=own(u,'N',5,9,[trait()]);
  const results=await Promise.allSettled([game.redeemCoupon(u,'LIMKETMON'),game.redeemCoupon(u,'LIMKETMON')]);
  const success=results.filter((r)=>r.status==='fulfilled');assert.equal(success.length,1);
  assert.deepEqual(success[0].value.granted,{credits:10,low:50,sr:0,ssr:1});assert.equal(state(u).low_tickets,50);
  // The real code is a deploy-time secret; the test injects its own fixture value and restores it.
  env.PRIVATE_CARD_COUPON='INTERNAL-FIXTURE-COUPON';
  try { await Promise.all([game.redeemCoupon(u,' internal-fixture-coupon '),game.redeemCoupon(u,'INTERNAL-FIXTURE-COUPON')]); }
  finally { delete env.PRIVATE_CARD_COUPON; }
  const rows=await game.ownedRows(u);assert.equal(rows.length,game.cards.length);
  for(const c of game.cards) assert.equal(row(u,c.id).quantity,c.id===id?205:200);
  assert.equal(row(u,id).enhance_level,9);assert.deepEqual(JSON.parse(row(u,id).traits),[trait()]);assert.equal((await game.getSnapshot(u)).completion,100);
});

test('private coupon stays disabled without a secret and repeats with one, leaking nothing',async()=>{
  const u=await user(),id=own(u,'N',5,9,[trait()]);
  assert.equal(env.PRIVATE_CARD_COUPON,undefined);
  await assert.rejects(()=>game.redeemCoupon(u,'INTERNAL-FIXTURE-COUPON'),/유효하지 않은/);
  env.PRIVATE_CARD_COUPON='';
  await assert.rejects(()=>game.redeemCoupon(u,'INTERNAL-FIXTURE-COUPON'),/유효하지 않은/);
  assert.equal((await game.ownedRows(u)).length,1);assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE user_id=?').bind(u).first().c,0);
  try {
    env.PRIVATE_CARD_COUPON='  internal-fixture-coupon  ';
    for(const code of ['INTERNAL-FIXTURE-COUPON','internal-fixture-coupon',' internal-fixture-coupon ']){
      const receipt=await game.redeemCoupon(u,code);
      assert.deepEqual(receipt.granted,{credits:0,low:0,sr:0,ssr:0,cards:game.cards.length*100,cardTypes:game.cards.length,copiesPerCard:100});
      assert.ok(!JSON.stringify(receipt).includes('fixture'));
    }
  } finally { delete env.PRIVATE_CARD_COUPON; }
  const rows=await game.ownedRows(u);assert.equal(rows.length,game.cards.length);
  for(const c of game.cards) assert.equal(row(u,c.id).quantity,c.id===id?305:300);
  assert.equal(row(u,id).enhance_level,9);assert.deepEqual(JSON.parse(row(u,id).traits),[trait()]);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM coupon_redemptions WHERE user_id=?').bind(u).first().c,0);
});

test('low tickets cannot use free pull or other wallets and concurrent pulls have exact receipts',async()=>{
  const u=await user();balances(u);db.prepare('UPDATE user_game_state SET pull_credits=9,sr_tickets=8,ssr_tickets=7 WHERE user_id=?').bind(u).run();
  await assert.rejects(()=>game.pullCards(u,1,'low'));assert.equal((await game.ownedRows(u)).length,0);
  db.prepare('UPDATE user_game_state SET low_tickets=2 WHERE user_id=?').bind(u).run();
  const results=await Promise.allSettled(Array.from({length:5},()=>game.pullCards(u,1,'low')));
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,2);
  assert.equal(state(u).low_tickets,0);assert.equal(state(u).pull_credits,9);assert.equal(state(u).sr_tickets,8);assert.equal(state(u).ssr_tickets,7);assert.equal(state(u).last_free_pull_date,null);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM pull_history WHERE user_id=?').bind(u).first().c,2);
});

test('battle slot parser preserves full progress and rejects corrupt traits',()=>{
  const progress={baseCardId:card('N').id,rarity:'XR',enhanceLevel:5,traits:[trait(10,true),{id:'synergy',level:9,transcended:false}]};
  assert.deepEqual(parseDeckSlots(JSON.stringify([{id:'variant',lv:0,progress}])),[{id:'variant',enhance:5,progress}]);
  assert.deepEqual(parseDeckSlots([{id:'variant',progress:{...progress,traits:[trait(21)]}}]),[]);
});

// Settlement fixtures use full stored progress and the live ruleset/engine, so combat integration
// changes neither their storage contract nor their player-decision generation.
async function battle(u:string,mode:BattleMode='normal',opponentId='rookie',kind:'pve'|'daily'='pve') {
  const ids=game.cards.filter((c)=>['UR','SSR'].includes(c.rarity)).sort((a,b)=>Number(b.rarity==='UR')-Number(a.rarity==='UR')).slice(0,3).map((c)=>c.id);
  const slots=ids.map((id)=>({id,lv:15,progress:{baseCardId:id,rarity:game.cards.find((c)=>c.id===id)!.rarity,enhanceLevel:15,traits:[]}}));
  const id=crypto.randomUUID();
  const options={kind,mode,opponentId,modifier:{kind:'none' as const},seed:12345,playerCardIds:ids,playerEnhance:slots.map((s)=>s.lv),playerProgress:slots.map((s)=>s.progress),battleId:id};
  const setup=buildSetup(options);let state=createBattle(setup);const decisions:Decision[]=[];
  for(let i=0;i<1000 && state.status==='active';i++){
    const decision=aiDecision(state,opponentById(opponentId,mode)!.profile);
    const result=advance(state,decision);assert.equal(result.error,undefined);if(decision.uid.startsWith('a'))decisions.push(decision);state=result.state;
  }
  assert.equal(state.status,'won','fixture must actually win');
  db.prepare("INSERT INTO battles (id,user_id,kind,mode,opponent_id,ruleset_version,seed,deck_cards,kst_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,u,kind,mode,opponentId,BATTLE_RULESET_VERSION,12345,JSON.stringify(slots),'2026-09-10','now').run();
  return {id,decisions};
}

test('daily object claims pay once with exact receipts across concurrent battles and retries',async()=>{
  const u=await user(),a=await battle(u,'normal','rookie','daily'),b=await battle(u,'normal','rookie','daily');
  const receipts=await Promise.all([game.finishBattle(u,a.id,a.decisions),game.finishBattle(u,b.id,b.decisions)]);
  assert.equal(receipts.flatMap((r)=>r.rewards).filter((r)=>r.label==='데일리 챌린지 보상').reduce((s,r)=>s+r.credits,0),DAILY_REWARD_CREDITS);
  assert.equal(receipts.flatMap((r)=>r.rewards).filter((r)=>r.ticketType).length,0);
  assert.equal(state(u).pull_credits,receipts.flatMap((r)=>r.rewards).reduce((s,r)=>s+r.credits,0));
  assert.deepEqual(await game.finishBattle(u,a.id,a.decisions),receipts[0]);
});

test('all 15 victory tiers pay first/repeat exact receipts; concurrent finish is idempotent',async()=>{
  const tiers=[['normal','rookie','low',2],['normal','regular','low',3],['normal','veteran','low',4],['normal','ace','normal',2],['normal','boss','normal',3],['hard','rookie','normal',3],['hard','regular','normal',4],['hard','veteran','normal',5],['hard','ace','normal',6],['hard','boss','sr',2],['chaos','rookie','sr',2],['chaos','regular','sr',3],['chaos','veteran','sr',4],['chaos','ace','ssr',2],['chaos','boss','ssr',3]] as const;
  for(const [mode,opponent,type,quantity] of tiers){
    const u=await user(),a=await battle(u,mode,opponent);
    const [first,retry]=await Promise.all([game.finishBattle(u,a.id,a.decisions),game.finishBattle(u,a.id,a.decisions)]);assert.deepEqual(retry,first);
    assert.deepEqual(first.rewards.filter((r)=>r.ticketType).map((r)=>[r.ticketType,r.quantity]),[[type,quantity],[type,quantity]]);
    const b=await battle(u,mode,opponent),repeat=await game.finishBattle(u,b.id,b.decisions);
    assert.deepEqual(repeat.rewards.filter((r)=>r.ticketType).map((r)=>[r.ticketType,r.quantity]),[[type,quantity]]);
    const column={low:'low_tickets',normal:'pull_credits',sr:'sr_tickets',ssr:'ssr_tickets'}[type];
    const creditRewards=[first,repeat].flatMap((r)=>r.rewards).reduce((s,r)=>s+r.credits,0);
    assert.equal(state(u)[column],quantity*3+(type==='normal'?creditRewards:0));
  }
});


test('no fusion candidate refuses without consuming UR materials',async()=>{
  const u=await user(),id=own(u,'UR',2,5,[trait()]); const before=dump(u);
  assert.equal(game.cards.filter((c)=>c.rarity==='UR').length,1,'current catalog has one UR kind');
  await assert.rejects(()=>applyProgression(u,{action:'fuse',count:2,cards:[{cardId:id,quantity:2}]}));
  assert.equal(dump(u),before);
});

test('start stores full progress; replay uses it after mutation and refuses old rulesets',async()=>{
  const u=await user(),ids=game.cards.filter((c)=>['SSR','UR'].includes(c.rarity)).slice(0,3).map((c)=>c.id);
  for(const [i,id] of ids.entries()){
    const base=game.cards.find((c)=>c.id===id)!; own(u,base.rarity,20,5,[trait()],id,id);
    db.prepare('INSERT INTO deck_cards VALUES (?,?,?)').bind(u,i,id).run();
  }
  const started=await game.startBattle(u,{deckId:u,opponentId:'rookie'});
  const stored=db.prepare('SELECT deck_cards FROM battles WHERE id=?').bind(started.battleId).first().deck_cards;
  const slots=parseDeckSlots(stored); assert.equal(slots.length,3);
  for(const slot of slots) assert.deepEqual(slot.progress,{baseCardId:slot.id,rarity:game.cards.find((c)=>c.id===slot.id)!.rarity,enhanceLevel:5,traits:[trait()]});
  const before=await game.replayBattle(u,started.battleId);
  db.prepare("UPDATE inventory SET enhance_level=15,traits='[]' WHERE user_id=?").bind(u).run();
  db.prepare('DELETE FROM deck_cards WHERE deck_id=?').bind(u).run();
  await dismantle(u,ids[0]!,20);
  const after=await game.replayBattle(u,started.battleId);
  assert.deepEqual(after.setup,before.setup);assert.deepEqual(after.events,before.events);
  db.prepare('UPDATE battles SET ruleset_version=? WHERE id=?').bind(BATTLE_RULESET_VERSION-1,started.battleId).run();
  await assert.rejects(()=>game.replayBattle(u,started.battleId),(e:unknown)=>e instanceof game.GameError && e.code==='old_ruleset');
});

test('deck database guards reject missing ownership and duplicate base kinds',async()=>{
  const u=await user(),id=own(u),variant=own(u,'R',1,0,[],crypto.randomUUID(),id);
  db.prepare('INSERT INTO deck_cards VALUES (?,0,?)').bind(u,id).run();
  assert.throws(()=>db.prepare('INSERT INTO deck_cards VALUES (?,1,?)').bind(u,variant).run(),/invalid_owned_deck/);
  assert.throws(()=>db.prepare('INSERT INTO deck_cards VALUES (?,1,?)').bind(u,'foreign').run(),/invalid_owned_deck/);
});


test('each effective rarity dismantles at its specified proof rate',async()=>{
  for(const [rarity,proof] of [['N',1],['R',3],['SR',6],['SSR',10],['UR',25],['XR',40]] as const){
    const u=await user(),id=own(u,rarity,1,0,[],crypto.randomUUID(),card('N').id);
    await dismantle(u,id,1);assert.equal(state(u).proof,proof);
    if(rarity==='UR'||rarity==='XR')assert.equal(state(u).fragments,1);
  }
});

test('distinct concurrent first victories pay two win rewards and only one first-clear extra',async()=>{
  const u=await user(),a=await battle(u),b=await battle(u);
  const receipts=await Promise.all([game.finishBattle(u,a.id,a.decisions),game.finishBattle(u,b.id,b.decisions)]);
  assert.equal(receipts.flatMap((r)=>r.rewards).filter((r)=>r.ticketType==='low').reduce((sum,r)=>sum+r.quantity!,0),6);
  assert.equal(state(u).low_tickets,6);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM reward_claims WHERE user_id=? AND claim_key='pve_first:rookie'").bind(u).first().c,1);
});

test('invalid submitted decisions pay nothing and do not consume the settlement gate',async()=>{
  const u=await user(),a=await battle(u);
  const result=await game.finishBattle(u,a.id,[]);
  assert.equal(result.result,'invalid');assert.deepEqual(result.rewards,[]);assert.equal(state(u).low_tickets,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reward_claims WHERE user_id=?').bind(u).first().c,0);
  assert.equal((await game.finishBattle(u,a.id,a.decisions)).result,'won');
});


test('a real loss settles without victory tickets and retry cannot create rewards',async()=>{
  const u=await user(),id=crypto.randomUUID();
  const ids=game.cards.filter((c)=>c.rarity==='N').slice(0,3).map((c)=>c.id);
  const slots=ids.map((id)=>({id,lv:0,progress:{baseCardId:id,rarity:'N' as const,enhanceLevel:0,traits:[]}}));
  const options={kind:'pve' as const,mode:'chaos' as const,opponentId:'boss',modifier:{kind:'none' as const},seed:12345,playerCardIds:ids,playerProgress:slots.map((s)=>s.progress)};
  let state=createBattle(buildSetup(options));const decisions:Decision[]=[];
  for(let i=0;i<1000 && state.status==='active';i++){
    const decision=aiDecision(state,opponentById('boss','chaos')!.profile);
    const result=advance(state,decision);assert.equal(result.error,undefined);
    if(decision.uid.startsWith('a'))decisions.push(decision);state=result.state;
  }
  assert.equal(state.status,'lost');
  db.prepare("INSERT INTO battles (id,user_id,kind,mode,opponent_id,ruleset_version,seed,deck_cards,kst_date,created_at) VALUES (?,?,'pve','chaos','boss',?,12345,?,'2026-09-10','now')").bind(id,u,BATTLE_RULESET_VERSION,JSON.stringify(slots)).run();
  const result=await game.finishBattle(u,id,decisions);assert.equal(result.result,'lost');
  assert.equal(result.rewards.filter((r)=>r.ticketType).length,0);
  const before=dump(u);assert.deepEqual(await game.finishBattle(u,id,decisions),result);assert.equal(dump(u),before);
});


test('snapshot uses battle-time rarity per slot, current rarity for collection, and stored rounds', async () => {
  const u=await user();
  for(const rarity of ['N','R','SR','SSR','UR']) own(u,rarity);
  const id=card('UR').id;
  for(const [index,rarity] of ['XR','R'].entries()) {
    const slots=[{id,progress:{baseCardId:id,rarity,enhanceLevel:5,traits:[]}}];
    db.prepare("INSERT INTO battles (id,user_id,kind,opponent_id,ruleset_version,seed,deck_cards,kst_date,created_at,result,rounds) VALUES (?,?,'pve','rookie',?,1,?,'2026-09-10',?,'won',7)")
      .bind(crypto.randomUUID(),u,BATTLE_RULESET_VERSION,JSON.stringify(slots),String(index)).run();
  }
  const snapshot=await game.getSnapshot(u);
  assert.deepEqual(snapshot.stats.rarityUsage,{R:1,XR:1});
  assert.ok(snapshot.stats.satisfied.includes('all_rarities'));
  assert.equal(snapshot.recentBattles[0]!.rounds,7);
});

test('achievement counters include victories outside the 200-row history window', async () => {
  const u=await user();
  for(let i=0;i<201;i++) db.prepare("INSERT INTO battles (id,user_id,kind,opponent_id,ruleset_version,seed,deck_cards,kst_date,created_at,result,n_only,clutch) VALUES (?,?,'pve','rookie',?,1,'[]','2026-09-10',?,?,?,?)")
    .bind(crypto.randomUUID(),u,BATTLE_RULESET_VERSION,String(i).padStart(3,'0'),i===0?'won':'lost',i===0?1:0,i===0?1:0).run();
  const snapshot=await game.getSnapshot(u);
  assert.equal(snapshot.stats.battles,201);assert.equal(snapshot.stats.wins,1);assert.equal(snapshot.stats.losses,200);
  for(const achievement of ['first_win','n_only_win','clutch_win']) assert.ok(snapshot.stats.satisfied.includes(achievement));
});

test('owned variant deck validation, shared enhancement and transcend preserve battle snapshot', async () => {
  const u=await user(),base=card('N').id,variant=own(u,'R',1,5,[trait()],crypto.randomUUID(),base);
  own(u,'N',20);
  const others=[card('N',1).id,card('N',2).id];
  for(const id of others) own(u,'N',1,0,[],id,id);
  await assert.rejects(()=>game.saveDeck(u,u,[base,variant,others[0]]),(e:unknown)=>e instanceof game.GameError && e.code==='invalid_deck');
  await game.saveDeck(u,u,[variant,...others]);
  const started=await game.startBattle(u,{deckId:u,opponentId:'rookie'});
  const before=await game.replayBattle(u,started.battleId);
  await game.enhanceCard(u,variant); balances(u);
  const evolved=await trans(u,variant);
  assert.equal(row(u,variant),null); assert.equal(row(u,evolved.cardId).enhance_level,6);
  assert.equal((await game.listDecks(u))[0]!.cards[0],evolved.cardId);
  const after=await game.replayBattle(u,started.battleId);
  assert.deepEqual(after.setup,before.setup);assert.deepEqual(after.events,before.events);
});
