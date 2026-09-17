const PRESS_ROLES = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'radio-button', 'tab', 'tab-bar-item', 'menuitem', 'cell', 'radiobutton', 'tabbaritem', 'segmentedcontrol', 'key']);
const normalizeRole = value => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD_ROLES = new Set(['text-field', 'textfield', 'secure-text-field', 'textbox', 'edittext', 'search-field', 'searchfield', 'securetextfield', 'textview', 'textarea']);

export const visibleNodes = snapshot => snapshot.nodes.filter(n => n.visibleToUser !== false);

export function assertReadable(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
    throw new Error('No readable app state. Jev needs an accessibility snapshot.');
  }
  if (snapshot.truncated || snapshot.snapshotQuality?.state === 'sparse') {
    throw new Error('The app snapshot is incomplete; cannot make a reliable decision from it.');
  }
}

export function buildActions(snapshot, inputs = {}) {
  assertReadable(snapshot);
  const actions = [
    { id: 'qa_pass', kind: 'verdict', status: 'passed', description: 'Finish with QA PASS. The observed app state and executed actions satisfy the task and its constraints. The evidence establishes the outcome the task actually asks to verify. An already-satisfied task can pass without extra actions unless the task explicitly requires replaying the steps.' },
    { id: 'qa_fail', kind: 'verdict', status: 'failed', description: 'Finish with QA FAIL. Observed behavior contradicts the task, or an executed action violated a task constraint. Missing evidence alone is not a failure.' },
    { id: 'incomplete', kind: 'verdict', status: 'incomplete', description: 'Finish as INCOMPLETE. The outcome cannot be determined and no available action can obtain the missing evidence or advance the task.' },
    { id: 'need_input', kind: 'blocked', description: 'The task needs text input that was not supplied. Stop as incomplete.' },
    { id: 'wait', kind: 'wait', description: 'Wait briefly for loading or an animation, then read the screen again.' },
    { id: 'back', kind: 'back', description: 'Navigate back within the app.' },
    ...['up', 'down', 'left', 'right'].map(direction => ({ id: `scroll_${direction}`, kind: 'scroll', direction, description: `Scroll ${direction} to reveal more content.` })),
  ];
  for (const node of visibleNodes(snapshot)) {
    if (!node.ref || node.enabled === false || node.hittable === false || node.interactionBlocked) continue;
    const baseRef = node.ref.startsWith('@') ? node.ref : `@${node.ref}`;
    const ref = snapshot.refsGeneration != null && !baseRef.includes('~s')
      ? `${baseRef}~s${snapshot.refsGeneration}` : baseRef;
    const label = node.label || node.identifier || node.value || node.ref;
    const roles = [node.type, node.role].filter(Boolean).map(normalizeRole);
    const role = roles.find(r => FIELD_ROLES.has(r) || PRESS_ROLES.has(r)) || roles[0] || 'control';
    if (FIELD_ROLES.has(role) || node.editable === true) {
      actions.push({ id: `a${actions.length}`, kind: 'press', ref, target: node.identifier || label,
        description: `Focus ${role} ${JSON.stringify(label)} at ${node.ref}.` });
      for (const [name, text] of Object.entries(inputs)) {
        actions.push({ id: `a${actions.length}`, kind: 'fill', ref, target: node.identifier || label, text, inputName: name,
          description: `Fill ${role} ${JSON.stringify(label)} with ${JSON.stringify(text)}.` });
      }
    } else if (PRESS_ROLES.has(role) || (node.hittable === true && node.label)) {
      actions.push({ id: `a${actions.length}`, kind: 'press', ref, target: node.identifier || label,
        description: `Press ${role || 'control'} ${JSON.stringify(label)} at ${node.ref}.` });
    }
  }
  if (actions.length > 255) throw new Error('More than 255 actions on this screen. Narrow the snapshot scope or supply fewer input values.');
  return actions;
}

export function prepareSnapshot(snapshot) {
  return {
    app: snapshot.appBundleId || snapshot.appName,
    visibility: snapshot.visibility,
    nodes: visibleNodes(snapshot).map(({ ref, role, type, label, value, identifier, enabled, selected, editable,
      parentIndex, index, rect, visibleToUser, hittable, interactionBlocked, presentationHints,
      hiddenContentAbove, hiddenContentBelow }) =>
      ({ ref, role: type || role, label, value, identifier, enabled, selected, editable, parentIndex, index,
        rect, visibleToUser: visibleToUser ?? null, hittable: hittable ?? null, interactionBlocked,
        presentationHints, hiddenContentAbove, hiddenContentBelow })),
  };
}

export function fingerprint(snapshot) {
  return JSON.stringify(prepareSnapshot(snapshot).nodes.map(({ ref, index, parentIndex, ...node }) => node));
}
