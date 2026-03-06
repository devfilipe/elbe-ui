/* ==========================================================================
   ELBE UI – Maintainers view (multi-maintainer CRUD)
   ========================================================================== */

let _maintainerEditIndex = -1;  // -1 = new

async function loadMaintainers() {
  const d = await api('/api/maintainers');
  const el = document.getElementById('maintainers-list');
  if (!el) return;

  const list = d.maintainers || [];
  if (!list.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No maintainers configured. Click "+ Add Maintainer" to create one.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>#</th><th>Name</th><th>Email</th><th>GPG Keys</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  list.forEach((m, i) => {
    const hasKeys = m.has_keys
      ? '<span class="badge ok">Key OK</span>'
      : '<span class="badge warn">No key</span>';
    const orgLabel = m.organization ? `<span style="font-size:.75rem;color:var(--text-dim)"> · ${m.organization}</span>` : '';
    html += `<tr>
      <td style="color:var(--text-dim);font-size:.8rem">${i}</td>
      <td style="font-weight:600">${m.name || '—'}${orgLabel}</td>
      <td style="font-family:monospace;font-size:.85rem">${m.email || '—'}</td>
      <td>${hasKeys}</td>
      <td class="btn-row" style="border:0;flex-wrap:nowrap">
        <button class="btn secondary" onclick="maintainerShowEdit(${i})">Edit</button>
        <button class="btn secondary" onclick="maintainerManageKeys(${i})">Keys</button>
        <button class="btn danger" onclick="maintainerDelete(${i})">✕</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ---------- Add / Edit ---------- */

function maintainerShowAdd() {
  _maintainerEditIndex = -1;
  document.getElementById('maintainer-form-title').textContent = 'Add Maintainer';
  document.getElementById('maintainer-form-name').value = '';
  document.getElementById('maintainer-form-email').value = '';
  document.getElementById('maintainer-form-org').value = '';
  document.getElementById('maintainer-form').style.display = 'block';
}

function maintainerShowEdit(index) {
  api('/api/maintainers').then(d => {
    const m = (d.maintainers || [])[index];
    if (!m) return;
    _maintainerEditIndex = index;
    document.getElementById('maintainer-form-title').textContent = 'Edit Maintainer';
    document.getElementById('maintainer-form-name').value = m.name || '';
    document.getElementById('maintainer-form-email').value = m.email || '';
    document.getElementById('maintainer-form-org').value = m.organization || '';
    document.getElementById('maintainer-form').style.display = 'block';
  });
}

function maintainerCancelForm() {
  document.getElementById('maintainer-form').style.display = 'none';
}

async function maintainerSaveForm() {
  const body = {
    name:         document.getElementById('maintainer-form-name').value.trim(),
    email:        document.getElementById('maintainer-form-email').value.trim(),
    organization: document.getElementById('maintainer-form-org').value.trim(),
  };
  if (!body.name || !body.email) { toast('Name and email are required', 'error'); return; }

  let d;
  if (_maintainerEditIndex >= 0) {
    d = await api(`/api/maintainers/${_maintainerEditIndex}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    d = await api('/api/maintainers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (d.index !== undefined) {
    toast(_maintainerEditIndex >= 0 ? 'Maintainer updated' : 'Maintainer added', 'success');
    document.getElementById('maintainer-form').style.display = 'none';
    loadMaintainers();
  } else {
    toast(d.detail || 'Failed to save', 'error');
  }
}

async function maintainerDelete(index) {
  const d = await api('/api/maintainers');
  const m = (d.maintainers || [])[index];
  if (!m) return;
  if (!confirm(`Delete maintainer "${m.name} <${m.email}>"?\n\nThis also removes their GPG key store.`)) return;

  const result = await api(`/api/maintainers/${index}`, { method: 'DELETE' });
  if (result.deleted) {
    toast('Maintainer deleted', 'success');
    document.getElementById('maintainer-keys-panel').style.display = 'none';
    loadMaintainers();
  } else {
    toast(result.detail || 'Failed to delete', 'error');
  }
}

/* ---------- GPG Keys ---------- */

let _maintainerKeysIndex = -1;

async function maintainerManageKeys(index) {
  _maintainerKeysIndex = index;
  const d = await api('/api/maintainers');
  const m = (d.maintainers || [])[index];
  if (!m) return;

  document.getElementById('maintainer-keys-title').textContent =
    `GPG Keys — ${m.name} <${m.email}>`;
  document.getElementById('maintainer-keys-panel').style.display = 'block';
  await _maintainerRefreshKeys();
}

const _GPG_ALGO = {
  '1': 'RSA', '2': 'RSA', '3': 'RSA', '17': 'DSA',
  '18': 'ECDH', '19': 'ECDSA', '22': 'EdDSA',
};

async function _maintainerRefreshKeys() {
  if (_maintainerKeysIndex < 0) return;
  const d = await api(`/api/maintainers/${_maintainerKeysIndex}/gpg-keys`);
  const el = document.getElementById('maintainer-keys-list');
  const keys = d.keys || [];

  if (!keys.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No GPG keys. Click "Generate Key" to create one.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>UID</th><th>Key ID</th><th>Algorithm</th><th>Created</th><th>Expires</th><th>Status</th>' +
    '</tr></thead><tbody>';

  keys.forEach(k => {
    const status = k.expired
      ? '<span class="badge err">Expired</span>'
      : '<span class="badge ok">Active</span>';
    html += `<tr>
      <td style="font-size:.85rem">${k.uid || '—'}</td>
      <td style="font-family:monospace;font-size:.78rem">${k.keyid || '—'}</td>
      <td style="font-size:.82rem">${_GPG_ALGO[k.algo] || k.algo || '—'}</td>
      <td style="font-size:.82rem;color:var(--text-dim)">${k.created || '—'}</td>
      <td style="font-size:.82rem;color:var(--text-dim)">${k.expires || 'never'}</td>
      <td>${status}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function maintainerGenKey() {
  if (_maintainerKeysIndex < 0) return;
  const d = await api('/api/maintainers');
  const m = (d.maintainers || [])[_maintainerKeysIndex];
  if (!m) return;
  if (!confirm(`Generate a new GPG key for "${m.name} <${m.email}>"?`)) return;

  show('maintainer-output', 'Generating GPG key… this may take a moment.');
  const result = await api(`/api/maintainers/${_maintainerKeysIndex}/gen-keys`, { method: 'POST' });
  show('maintainer-output', result);

  if (result.keyid) {
    toast(`Key generated: ${result.keyid}`, 'success');
    await _maintainerRefreshKeys();
    loadMaintainers();
  } else {
    toast('Key generation failed', 'error');
  }
}

async function maintainerExportPubKey() {
  if (_maintainerKeysIndex < 0) return;
  const d = await api(`/api/maintainers/${_maintainerKeysIndex}/export-public`);
  if (d.public_key) {
    show('maintainer-output', d.public_key);
    try {
      await navigator.clipboard.writeText(d.public_key);
      toast('Public key copied to clipboard', 'success');
    } catch {
      toast('Public key shown in output below', 'info');
    }
  } else {
    toast(d.error || 'No public key found', 'error');
  }
}
