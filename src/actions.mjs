const PRESS_ROLES = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'radio-button', 'tab', 'tab-bar-item', 'menuitem', 'cell']);
const FIELD_ROLES = new Set(['text-field', 'textfield', 'secure-text-field', 'textbox', 'edittext', 'search-field', 'textarea']);

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
    { id: 'done', kind: 'done', description: 'The requested journey is complete. The current screen provides evidence of the requested final outcome. Finish and evaluate the acceptance checks.' },
    { id: 'blocked', kind: 'blocked', description: 'Cannot continue with the available controls or context. Stop as incomplete.' },
    { id: 'need_input', kind: 'blocked', description: 'The task needs text input that was not supplied. Stop as incomplete.' },
    { id: 'wait', kind: 'wait', description: 'Wait briefly for loading or an animation, then read the screen again.' },
    { id: 'back', kind: 'back', description: 'Navigate back within the app.' },
    ...['up', 'down', 'left', 'right'].map(direction => ({ id: `scroll_${direction}`, kind: 'scroll', direction, description: `Scroll ${direction} to reveal more content.` })),
  ];
  for (const node of visibleNodes(snapshot)) {
    if (!node.ref || node.enabled === false || node.hittable === false || node.interactionBlocked) continue;
    const ref = snapshot.refsGeneration != null && !node.ref.includes('~s')
      ? `${node.ref}~s${snapshot.refsGeneration}` : node.ref;
    const label = node.label || node.identifier || node.value || node.ref;
    const role = (node.role || node.type || '').toLowerCase();
    if (FIELD_ROLES.has(role) || node.editable === true) {
      for (const [name, text] of Object.entries(inputs)) {
        actions.push({ id: `a${actions.length}`, kind: 'fill', ref, target: node.identifier || label, text, inputName: name,
          description: `Fill ${role} ${JSON.stringify(label)} with the supplied input named ${JSON.stringify(name)}.` });
      }
    } else if (PRESS_ROLES.has(role) || (node.hittable === true && node.label)) {
      actions.push({ id: `a${actions.length}`, kind: 'press', ref, target: node.identifier || label,
        description: `Press ${role || 'control'} ${JSON.stringify(label)} at ${node.ref}.` });
    }
  }
  if (actions.length > 255) throw new Error('More than 255 actions on this screen. Narrow the snapshot scope or supply fewer input values.');
  return actions;
}

export function modelState(snapshot) {
  return {
    app: snapshot.appBundleId || snapshot.appName,
    nodes: visibleNodes(snapshot).map(({ ref, role, type, label, value, identifier, enabled, selected, editable, parentIndex, index }) =>
      ({ ref, role: role || type, label, value, identifier, enabled, selected, editable, parentIndex, index })),
  };
}

export function fingerprint(snapshot) {
  return JSON.stringify(modelState(snapshot).nodes.map(({ ref, index, parentIndex, ...node }) => node));
}
