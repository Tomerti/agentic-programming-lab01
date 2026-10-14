// Missions: the objectives of one round and how the session's events advance them. The session makes a
// tracker from the round's mission ids, forwards every event it emits to onEvent and pays the rewards that
// come back; the tracker emits nothing itself. The texts, rewards and goals are MISSIONS in config.js, the
// time limit of clearJam is TIMING.clearJamWindow.
import { MISSIONS, TIMING } from '../config.js';

// The handler of a mission that one type of event completes, when the payload of that event passes `test`.
const completesOn = (event, test) => (_mission, type, payload) => type === event && test(payload);

// A tracker for the missions `ids`, in that order, with `missions` (its own list, which events update in
// place: read it, do not change it), `onEvent(type, payload)` and `status()` (a copy of the list to hand
// out). `config` is the tables to read; tests pass their own. An id that is not a mission is a programming
// error: it throws, naming the id.
export function createMissionTracker(ids, config = { MISSIONS, TIMING }) {
  const { MISSIONS, TIMING } = config; // shadows the imports, which only serve as the default

  // What each mission makes of an event: (mission, type, payload) -> whether the mission is now complete. A
  // handler may update mission.progress on the way. A payload that lacks a field is no error: the rules
  // compare strictly, so the field simply is not the value they ask for.
  const handlers = {
    alertGilo: completesOn('alert:sounded', ({ zone, inTime }) => zone === 'gilo' && inTime === true),
    // Progress is the length of the current streak. An interception adds one. A missed interceptor ends the
    // streak, and so does an impact on a neighborhood, but not one on open ground or a decoy.
    streak3: (mission, type, { populated }) => {
      if (type === 'threat:intercepted') {
        mission.progress += 1;
        return mission.progress >= mission.goal;
      }
      if (type === 'interceptor:missed' || (type === 'threat:impact' && populated === true)) mission.progress = 0;
      return false;
    },
    noWaste: completesOn('wave:end', ({ shotsWasted, openOnly }) => shotsWasted === 0 && openOnly !== true),
    holdWave: completesOn('wave:end', ({ openOnly, holdAllWave }) => openOnly === true && holdAllWave === true),
    callUav: completesOn('hq:line', ({ uavOnRadar }) => uavOnRadar === true),
    clearJam: completesOn('hazard:jamming', ({ on, elapsed }) => on === false && elapsed <= TIMING.clearJamWindow),
    perfectRound: completesOn('round:end', ({ summary }) => summary?.impactsPopulated === 0),
    cruiseKill: completesOn('threat:intercepted', ({ threat }) => threat?.type === 'cruise'),
  };

  const missions = ids.map(id => {
    if (!Object.hasOwn(MISSIONS, id) || !Object.hasOwn(handlers, id)) throw new Error(`Unknown mission id: ${id}`);
    const { text, reward, goal } = MISSIONS[id];
    return { id, text, reward, goal, progress: 0, done: false };
  });

  // Offers the event to every mission that is not done and returns { id, reward } for each one it completes,
  // in the order of the missions. A mission completes once: from then on it is done, its progress is its
  // goal and it ignores every event.
  const onEvent = (type, payload) => {
    const data = payload ?? {};
    const completed = [];
    for (const mission of missions) {
      if (mission.done || !handlers[mission.id](mission, type, data)) continue;
      mission.done = true;
      mission.progress = mission.goal;
      completed.push({ id: mission.id, reward: mission.reward });
    }
    return completed;
  };

  // A copy of the missions, fresh on every call: it shows how far they are now and changing it does not
  // touch the tracker.
  const status = () => missions.map(mission => ({ ...mission }));

  return { missions, onEvent, status };
}
