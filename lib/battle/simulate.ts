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

export interface StepBattleResult {
  state: BattleState;
  events: BattleEvent[];
  decisions: Decision[];
  error?: string;
}

/**
 * Advances the battle state incrementally: applies the player's decision, then executes
 * deterministic opponent turns until the next player turn is reached or the battle ends.
 * Returns only newly produced events; never mutates incoming state or previous events.
 */
export function stepBattle(
  state: BattleState,
  playerDecision: Decision,
  decide: (state: BattleState) => Decision
): StepBattleResult {
  if (state.status !== 'active') return { state, events: [], decisions: [], error: 'ended' };
  const activeUid = state.activeUid;
  if (!activeUid || playerDecision.uid !== activeUid) return { state, events: [], decisions: [], error: 'uid' };
  if (!state.sides.a.some((combatant) => combatant.uid === activeUid)) return { state, events: [], decisions: [], error: 'uid' };

  const playerResult = advance(state, playerDecision);
  if (playerResult.error) {
    return { state: playerResult.state, events: [], decisions: [], error: playerResult.error };
  }

  let nextState = playerResult.state;
  const events: BattleEvent[] = [...playerResult.events];
  const decisions: Decision[] = [playerDecision];

  while (nextState.status === 'active') {
    const uid = nextState.activeUid;
    if (!uid) break;
    if (nextState.sides.a.some((combatant) => combatant.uid === uid)) break;

    const opDecision = decide(nextState);
    const opResult = advance(nextState, opDecision);
    if (opResult.error) {
      return { state: opResult.state, events, decisions, error: opResult.error };
    }
    nextState = opResult.state;
    events.push(...opResult.events);
    decisions.push(opDecision);
  }

  return { state: nextState, events, decisions };
}
