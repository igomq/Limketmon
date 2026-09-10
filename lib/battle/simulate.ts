// Drives createBattle + advance for a scripted player and a deterministic opponent.
// The opponent is never scripted: decide() is called (and re-called on every run)
// for each side-'b' turn, so a replay with the same seed and the same player
// decisions always produces the same opponent choices.
import type { BattleEvent, BattleSetup, BattleState, Decision } from './types.ts';
import { advance, createBattle } from './engine.ts';

export function runBattle(
  setup: BattleSetup,
  playerDecisions: Decision[],
  decide: (state: BattleState) => Decision
): { state: BattleState; decisions: Decision[]; events: BattleEvent[]; error?: string } {
  let state = createBattle(setup);
  /** Every decision actually applied, player and opponent, in turn order. */
  const decisions: Decision[] = [];
  let index = 0;

  while (state.status === 'active') {
    const uid = state.activeUid;
    if (!uid) break;
    let decision: Decision;
    if (state.sides.a.some((combatant) => combatant.uid === uid)) {
      if (index >= playerDecisions.length) return { state, decisions, events: [...state.log], error: 'unfinished' };
      decision = playerDecisions[index];
      index += 1;
      if (decision.uid !== uid) return { state, decisions, events: [...state.log], error: 'uid' };
    } else {
      decision = decide(state);
    }
    const result = advance(state, decision);
    if (result.error) return { state: result.state, decisions, events: [...result.state.log], error: result.error };
    state = result.state;
    decisions.push(decision);
  }
  return { state, decisions, events: [...state.log] };
}
