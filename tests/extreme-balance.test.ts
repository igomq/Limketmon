import assert from 'node:assert/strict';
import { buildSetup } from '../lib/battle/setup.ts';
import {createBattle,advance} from '../lib/battle/engine.ts';
import {aiDecision} from '../lib/battle/ai.ts';
import {opponentById} from '../lib/battle/opponents.ts';
const decks=[['033','041','028'],['002','019','003'],['020','006','045']];
for(const deck of decks) for(const opponentId of ['rookie','regular','veteran','ace','boss']) {
 let wins=0,rounds=0;
 for(let seed=1;seed<=12;seed++){
 const ids=deck.map(x=>'imsingyu-v'+x);
 const traits=['damage','synergy','resist_earth','resist_water','resist_fire','resist_grass','resist_dark'].map(id=>({id:id as any,level:20,transcended:true}));
 let state=createBattle(buildSetup({kind:'pve',mode:'extreme',opponentId,modifier:{kind:'none'},seed,playerCardIds:ids,playerProgress:ids.map(id=>({baseCardId:id,rarity:'XR',enhanceLevel:15,traits}))}));
 for(let n=0;n<500&&state.status==='active';n++){
 const profile=state.activeUid?.startsWith('a')?{healBelow:.65,lethalFirst:true,skillMinTargets:0,skillAppetite:1}:opponentById(opponentId,'extreme')!.profile;
 const result=advance(state,aiDecision(state,profile)); if(result.error)throw Error(result.error);state=result.state;
 }
 wins+=Number(state.status==='won');rounds+=state.round;
 }
 assert.ok(wins >= 6, `${deck} ${opponentId}: ${wins}/12 wins`);
 console.log(deck.join('/'),opponentId,wins+'/12','rounds',+(rounds/12).toFixed(1));
}
