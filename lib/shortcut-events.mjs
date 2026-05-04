import { getCurrentMember, listActiveIterations, listStoriesInIteration } from './shortcut-client.mjs';

// Builds events for stories that are:
//   - in an active iteration on one of the user's teams,
//   - in a "Ready" workflow state (matched by name, case-insensitive),
//   - owned by the current Shortcut member, and
//   - not archived.
//
// Fetches description lazily — the spawned Claude can hit /stories/{id}
// itself if it needs the full body, so we keep the polling cheap.
export async function buildShortcutEvents({ shortcut, log }) {
  const member = await getCurrentMember(shortcut);
  const myId = member?.id;
  if (!myId) {
    log?.error?.('shortcut: /member returned no id; skipping');
    return [];
  }

  const workflows = await shortcut('/workflows');
  const readyStateIds = new Set();
  for (const wf of workflows ?? []) {
    for (const st of wf.states ?? []) {
      if (String(st.name).toLowerCase() === 'ready') readyStateIds.add(st.id);
    }
  }
  if (readyStateIds.size === 0) {
    log?.debug?.('shortcut: no workflow state named "Ready" found across workflows');
    return [];
  }

  const iterations = await listActiveIterations(shortcut);
  log?.debug?.(`shortcut: ${iterations.length} active iteration(s)`);

  const events = [];
  for (const it of iterations) {
    const stories = await listStoriesInIteration(shortcut, it.id);
    for (const s of stories) {
      if (s.archived) continue;
      if (!readyStateIds.has(s.workflow_state_id)) continue;
      if (!Array.isArray(s.owner_ids) || !s.owner_ids.includes(myId)) continue;
      events.push({
        kind: 'shortcut_story',
        storyId: s.id,
        storyName: s.name,
        storyType: s.story_type ?? 'feature',
        appUrl: s.app_url,
        iterationId: it.id,
        iterationName: it.name,
        workflowStateId: s.workflow_state_id,
      });
    }
  }
  return events;
}
