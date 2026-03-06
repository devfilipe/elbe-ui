/* ==========================================================================
   ELBE UI – Settings view
   ========================================================================== */

async function loadSettings() {
  const s = await api('/api/settings');
  const fields = [
    'elbe_bin', 'vms_base_dir', 'soap_host', 'max_vms',
    'workspace_dir', 'projects_dir', 'upload_dir', 'output_dir',
    'builds_dir', 'sources_dir', 'packages_dir',
    'qemu_bin', 'qemu_memory', 'qemu_extra_args',
    'max_concurrent_submits',
  ];
  fields.forEach(key => {
    const el = document.getElementById('setting-' + key);
    if (el) el.value = s[key] || '';
  });
}

async function saveSettings() {
  const fields = [
    'elbe_bin', 'vms_base_dir', 'soap_host', 'max_vms',
    'workspace_dir', 'projects_dir', 'upload_dir', 'output_dir',
    'builds_dir', 'sources_dir', 'packages_dir',
    'qemu_bin', 'qemu_memory', 'qemu_extra_args',
    'max_concurrent_submits',
  ];
  const body = {};
  fields.forEach(key => {
    const el = document.getElementById('setting-' + key);
    if (el) body[key] = el.value;
  });
  const d = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (d.elbe_bin !== undefined) toast('Settings saved', 'success');
  else toast('Failed to save settings', 'error');
}
