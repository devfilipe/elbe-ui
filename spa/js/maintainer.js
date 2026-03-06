/* ==========================================================================
   ELBE UI – Maintainer view
   ========================================================================== */

/* ---------- Identity ---------- */

function _maintainerUpdateFormatted() {
  const name = document.getElementById('maintainer-name').value;
  const email = document.getElementById('maintainer-email').value;
  const formatted = name && email ? `${name} <${email}>` : '';
  document.getElementById('maintainer-formatted').value = formatted;
}

// Auto-update formatted field on input
document.addEventListener('DOMContentLoaded', () => {
  ['maintainer-name', 'maintainer-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _maintainerUpdateFormatted);
  });
});

async function maintainerLoad() {
  const d = await api('/api/maintainer');
  if (d.name !== undefined) {
    document.getElementById('maintainer-name').value = d.name || '';
    document.getElementById('maintainer-email').value = d.email || '';
    document.getElementById('maintainer-org').value = d.organization || '';
    _maintainerUpdateFormatted();
  }
  maintainerLoadKeys();
  maintainerLoadRepos();
}

async function maintainerSave() {
  const body = {
    name: document.getElementById('maintainer-name').value,
    email: document.getElementById('maintainer-email').value,
    organization: document.getElementById('maintainer-org').value,
  };
  if (!body.name || !body.email) {
    toast('Name and email are required', 'error');
    return;
  }
  const d = await api('/api/maintainer', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (d.name !== undefined) toast('Maintainer identity saved', 'success');
  else toast('Failed to save', 'error');
}

/* ---------- GPG Keys ---------- */

async function maintainerLoadKeys() {
  const d = await api('/api/maintainer/gpg-keys');
  const el = document.getElementById('maintainer-keys-list');
  if (!el) return;

  const keys = d.keys || [];
  if (!keys.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No GPG keys found. Click "Generate New Key" to create one.</p>';
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
      <td style="font-size:.82rem">${k.algo || '—'}</td>
      <td style="font-size:.82rem;color:var(--text-dim)">${k.created || '—'}</td>
      <td style="font-size:.82rem;color:var(--text-dim)">${k.expires || 'never'}</td>
      <td>${status}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function maintainerGenKey() {
  const name = document.getElementById('maintainer-name').value;
  const email = document.getElementById('maintainer-email').value;
  if (!name || !email) {
    toast('Save maintainer identity first (name + email required)', 'error');
    return;
  }
  if (!confirm(`Generate a new GPG key for "${name} <${email}>"?`)) return;

  show('maintainer-output', 'Generating GPG key… this may take a moment.');
  const d = await api('/api/maintainer/gpg-keys/generate', { method: 'POST' });
  show('maintainer-output', d);

  if (d.keyid) {
    toast(`Key generated: ${d.keyid}`, 'success');
    maintainerLoadKeys();
  } else {
    toast('Key generation failed', 'error');
  }
}

async function maintainerExportPubKey() {
  const d = await api('/api/maintainer/gpg-keys/export-public');
  if (d.public_key) {
    // Show in output and copy to clipboard
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

/* ---------- Repository Signing ---------- */

async function maintainerLoadRepos() {
  const d = await api('/api/apt-repos');
  const el = document.getElementById('maintainer-repos-list');
  if (!el) return;

  const repos = (d.repos || []).filter(r => !!r.local_dir);
  if (!repos.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No local repositories configured.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>Repository</th><th>GPG Keys</th><th>Index</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  repos.forEach((r, i) => {
    const keysStatus = r.has_keys
      ? '<span class="badge ok">OK</span>'
      : '<span class="badge warn">Missing</span>';
    const indexStatus = r.has_index
      ? '<span class="badge ok">Signed</span>'
      : '<span class="badge warn">Not built</span>';

    // Find the actual index in the full repos list
    const realIdx = (d.repos || []).indexOf(r);

    html += `<tr>
      <td style="font-weight:600">${r.label || r.uri}</td>
      <td>${keysStatus}</td>
      <td>${indexStatus}</td>
      <td class="btn-row" style="border:0;flex-wrap:nowrap">
        <button class="btn secondary" onclick="maintainerCopyKeysToRepo(${realIdx})">Copy Keys</button>
        <button class="btn" onclick="maintainerSignRepo(${realIdx})">Sign &amp; Rebuild</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function maintainerCopyKeysToRepo(repoIndex) {
  show('maintainer-output', 'Copying maintainer GPG keys to repository…');
  const d = await api(`/api/maintainer/gpg-keys/copy-to-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_index: repoIndex }),
  });
  show('maintainer-output', d);
  if (d.copied) toast('Keys copied to repo', 'success');
  else toast(d.error || 'Failed to copy keys', 'error');
  maintainerLoadRepos();
}

async function maintainerSignRepo(repoIndex) {
  show('maintainer-output', 'Rebuilding and signing repository…');
  const d = await api(`/api/apt-repos/${repoIndex}/rebuild`, { method: 'POST' });
  show('maintainer-output', d);
  if (d.returncode === 0) toast('Repository signed successfully', 'success');
  else toast('Signing failed', 'error');
  maintainerLoadRepos();
}

async function maintainerSignAllRepos() {
  const d = await api('/api/apt-repos');
  const repos = (d.repos || []).filter(r => !!r.local_dir);
  if (!repos.length) { toast('No local repos to sign', 'error'); return; }

  show('maintainer-output', `Signing ${repos.length} repo(s)…`);
  let ok = 0;
  for (let i = 0; i < (d.repos || []).length; i++) {
    const r = d.repos[i];
    if (!r.local_dir) continue;
    const result = await api(`/api/apt-repos/${i}/rebuild`, { method: 'POST' });
    if (result.returncode === 0) ok++;
  }
  toast(`${ok}/${repos.length} repos signed`, ok === repos.length ? 'success' : 'error');
  maintainerLoadRepos();
}
