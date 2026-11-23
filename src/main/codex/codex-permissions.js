const defaultMode = 'read-only';
const sandboxTypes = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
const workspaceProfile = ':workspace';
const valid = mode => typeof mode === 'string' && Object.hasOwn(sandboxTypes, mode);

function policy(mode) {
  const sandbox = valid(mode) ? mode : defaultMode;
  const approval = { approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request', approvalsReviewer: 'user' };
  if (sandbox === 'workspace-write') {
    const params = { ...approval, permissions: workspaceProfile };
    return { thread: params, turn: params };
  }
  return { thread: { ...approval, sandbox }, turn: { ...approval, sandboxPolicy: { type: sandboxTypes[sandbox] } } };
}

module.exports = { defaultMode, valid, policy };
