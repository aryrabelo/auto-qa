const PRESS_ROLES = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'radio-button', 'tab', 'tab-bar-item', 'menuitem', 'cell', 'radiobutton', 'tabbaritem', 'segmentedcontrol', 'key']);
const normalizeRole = value => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD_ROLES = new Set(['text-field', 'textfield', 'secure-text-field', 'textbox', 'edittext', 'search-field', 'searchfield', 'securetextfield', 'textview', 'textarea']);
const SELECT_ROLES = new Set(['combobox', 'select', 'spinner', 'picker']);
// Roles that only describe the screen. Their rendered lines are the first thing dropped under budget.
const STATIC_ROLES = new Set(['heading', 'text', 'alert', 'status', 'paragraph', 'staticText', 'document', 'image']);

export const visibleNodes = snapshot => snapshot.nodes.filter(n => n.visibleToUser !== false);

export function assertReadable(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
    throw new Error('No readable app state. The QA agent needs an accessibility snapshot of the screen.');
  }
  if (snapshot.truncated || snapshot.snapshotQuality?.state === 'sparse') {
    throw new Error('The app snapshot is incomplete; cannot make a reliable decision from it.');
  }
}

export function buildActions(snapshot, inputs = {}) {
  assertReadable(snapshot);
  const actions = [
    // There is no qa_pass: a pass is decided by verifying the expectations, never by this choice.
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
    const role = roles.find(r => FIELD_ROLES.has(r) || PRESS_ROLES.has(r) || SELECT_ROLES.has(r)) || roles[0] || 'control';
    const options = Array.isArray(node.options) ? node.options.filter(option => typeof option === 'string' && option.trim()) : [];
    if (SELECT_ROLES.has(role) && options.length) {
      for (const option of options) {
        actions.push({ id: `a${actions.length}`, kind: 'select', ref, target: node.identifier || label, value: option,
          description: `Select ${JSON.stringify(option)} in combobox ${JSON.stringify(label)}.` });
      }
    } else if (FIELD_ROLES.has(role) || node.editable === true) {
      actions.push({ id: `a${actions.length}`, kind: 'press', ref, target: node.identifier || label,
        description: `Focus ${role} ${JSON.stringify(label)} at ${node.ref}.` });
      for (const [name, text] of Object.entries(inputs)) {
        actions.push({ id: `a${actions.length}`, kind: 'fill', ref, target: node.identifier || label, text, inputName: name,
          description: `Fill ${role} ${JSON.stringify(label)} with ${JSON.stringify(text)}.` });
      }
    } else if (PRESS_ROLES.has(role) || (node.hittable === true && node.label)) {
      // A link to the page already shown cannot advance the task; say so instead of hiding it.
      const here = role === 'link' && (node.current === true || node.selected === true) ? ' (already the current page)' : '';
      actions.push({ id: `a${actions.length}`, kind: 'press', ref, target: node.identifier || label,
        description: `Press ${role || 'control'} ${JSON.stringify(label)} at ${node.ref}.${here}` });
    }
  }
  if (actions.length > 255) throw new Error('More than 255 actions on this screen. Narrow the snapshot scope with --scope or supply fewer input values.');
  return actions;
}

export function prepareSnapshot(snapshot) {
  return {
    app: snapshot.appBundleId || snapshot.appName,
    url: snapshot.url,
    visibility: snapshot.visibility,
    nodes: visibleNodes(snapshot).map(({ ref, role, type, label, value, identifier, enabled, selected, editable,
      parentIndex, index, rect, visibleToUser, hittable, interactionBlocked, presentationHints, options, current,
      hiddenContentAbove, hiddenContentBelow }) =>
      ({ ref, role: type || role, label, value, identifier, enabled, selected, editable, parentIndex, index,
        rect, visibleToUser: visibleToUser ?? null, hittable: hittable ?? null, interactionBlocked,
        presentationHints, options, current, hiddenContentAbove, hiddenContentBelow })),
  };
}

// Small local models read a compact transcript far better than a JSON tree: measured on kev-0.8b,
// true statements score >= 0.95 and false ones <= 0.81 against this rendering, versus no separation on JSON.
export function renderScreen(snapshot) {
  const prepared = prepareSnapshot(snapshot);
  const document = prepared.nodes.find(node => node.ref === 'doc');
  const lines = [`Page: ${document?.label || prepared.app || ''} — ${prepared.url ?? document?.value ?? ''}`];
  for (const node of prepared.nodes) {
    if (node.ref === 'doc') continue;
    let line = `${node.role || 'control'} ${JSON.stringify(node.label ?? '')}`;
    if (node.current) line += ' [current page]';
    if (node.selected) line += ' [selected]';
    if (node.value != null && node.value !== '') line += ` value=${JSON.stringify(node.value)}`;
    if (node.enabled === false) line += ' [disabled]';
    if (Array.isArray(node.options) && node.options.length) line += ` options: ${node.options.join(' | ')}`;
    lines.push(line);
  }
  if (document?.hiddenContentBelow) lines.push('(more content below)');
  if (document?.hiddenContentAbove) lines.push('(more content above)');
  return lines.join('\n');
}

// Used by the state budget: descriptive lines go before controls, and never the header or hints.
export function isStaticLine(line) {
  const role = /^(\S+) "/.exec(line)?.[1];
  return role != null && STATIC_ROLES.has(role);
}

export function fingerprint(snapshot) {
  return JSON.stringify(prepareSnapshot(snapshot).nodes.map(({ ref, index, parentIndex, ...node }) => node));
}
