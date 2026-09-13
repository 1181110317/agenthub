const PERM_MODES = Object.freeze(['auto', 'edits', 'plan', 'ask']);

function normalizePermissionState(autoPerms, permMode, fallbackMode) {
  let mode = PERM_MODES.includes(permMode) ? permMode : '';
  // `autoPerms` is legacy data, while `permMode` is the newer UI value.
  // Never let a stale/contradictory `permMode: auto` silently re-enable
  // bypass permissions when the legacy flag explicitly says false.
  if (mode === 'auto' && autoPerms !== true) mode = '';
  if (!mode) {
    if (autoPerms === true) mode = 'auto';
    else if (PERM_MODES.includes(fallbackMode) && fallbackMode !== 'auto') mode = fallbackMode;
    else mode = 'ask';
  }
  return { permMode: mode, autoPerms: mode === 'auto' };
}

module.exports = { PERM_MODES, normalizePermissionState };
