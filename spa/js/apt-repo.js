/* ==========================================================================
   ELBE UI – APT Repositories view
   ========================================================================== */

// Currently selected repo index for detail view
let _aptDetailIndex = -1;

async function loadAptRepos() {
  const d = await api('/api/apt-repos');
  const el = document.getElementById('apt-repos-list');
  if (!el) return;

  const repos = d.repos || [];
  if (!repos.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No repositories configured. Click "+ Add Repository" to get started.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>Label</th><th>Type</th><th>URI</th><th>Suite</th><th>Status</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  repos.forEach((r, i) => {
    const enabled = r.enabled !== false;
    const labelStyle = enabled ? '' : 'opacity:.5;text-decoration:line-through';
    const isLocal = !!r.local_dir;

    // Status badges
    let status = '';
    if (isLocal) {
      status += r.exists
        ? '<span class="badge ok">OK</span> '
        : '<span class="badge err">Missing</span> ';
      if (r.has_keys) status += '<span class="badge ok">GPG</span> ';
      if (r.has_index) status += '<span class="badge ok">Index</span> ';
      status += `<span style="font-size:.72rem;color:var(--text-dim)">${r.package_count || 0} bin`;
      if (r.source_count) status += `, ${r.source_count} src`;
      status += '</span>';
    } else {
      status += enabled
        ? '<span class="badge ok">Remote</span>'
        : '<span class="badge warn">Disabled</span>';
    }

    html += `<tr style="${labelStyle}">
      <td style="font-weight:600">${r.label || '(unnamed)'}</td>
      <td><code>${r.type || 'deb'}</code></td>
      <td style="font-family:monospace;font-size:.78rem;max-width:260px;overflow:hidden;text-overflow:ellipsis">${r.uri}</td>
      <td><code>${r.suite || './'}</code>${r.components ? ' <span style="color:var(--text-dim)">' + r.components + '</span>' : ''}</td>
      <td>${status}</td>
      <td class="btn-row" style="border:0;flex-wrap:nowrap">
        <button class="btn secondary" onclick="aptRepoEdit(${i})" title="Edit">✎</button>
        <button class="btn secondary" onclick="aptRepoShowSnippet(${i})" title="Show APT line">⟨⟩</button>
        ${isLocal ? `<button class="btn secondary" onclick="aptRepoShowDetail(${i})" title="Manage">▶</button>` : ''}
        <button class="btn danger" onclick="aptRepoRemove(${i})" title="Delete">✕</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

// Alias for navigation auto-load (core.js calls loadAptRepo)
function loadAptRepo() { loadAptRepos(); }

/* ---------- Add / Edit form ---------- */

function aptRepoShowAdd() {
  document.getElementById('apt-repo-form-title').textContent = 'Add Repository';
  document.getElementById('apt-repo-edit-index').value = '-1';
  _aptFormClear();
  document.getElementById('apt-repo-form').style.display = 'block';
}

function aptRepoEdit(index) {
  api('/api/apt-repos').then(d => {
    const r = (d.repos || [])[index];
    if (!r) return;
    document.getElementById('apt-repo-form-title').textContent = 'Edit Repository';
    document.getElementById('apt-repo-edit-index').value = index;
    document.getElementById('apt-repo-label').value = r.label || '';
    document.getElementById('apt-repo-type').value = r.type || 'deb';
    document.getElementById('apt-repo-uri').value = r.uri || '';
    document.getElementById('apt-repo-suite').value = r.suite || './';
    document.getElementById('apt-repo-components').value = r.components || '';
    document.getElementById('apt-repo-arch').value = r.arch || '';
    document.getElementById('apt-repo-signed-by').value = r.signed_by || '';
    document.getElementById('apt-repo-local-dir').value = r.local_dir || '';
    document.getElementById('apt-repo-trusted').checked = !!r.trusted;
    document.getElementById('apt-repo-enabled').checked = r.enabled !== false;
    document.getElementById('apt-repo-form').style.display = 'block';
  });
}

function _aptFormClear() {
  ['apt-repo-label','apt-repo-uri','apt-repo-suite','apt-repo-components',
   'apt-repo-arch','apt-repo-signed-by','apt-repo-local-dir'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('apt-repo-type').value = 'deb';
  document.getElementById('apt-repo-suite').value = './';
  document.getElementById('apt-repo-trusted').checked = false;
  document.getElementById('apt-repo-enabled').checked = true;
}

function _aptFormData() {
  return {
    label:      document.getElementById('apt-repo-label').value,
    type:       document.getElementById('apt-repo-type').value,
    uri:        document.getElementById('apt-repo-uri').value,
    suite:      document.getElementById('apt-repo-suite').value || './',
    components: document.getElementById('apt-repo-components').value,
    arch:       document.getElementById('apt-repo-arch').value,
    signed_by:  document.getElementById('apt-repo-signed-by').value,
    trusted:    document.getElementById('apt-repo-trusted').checked,
    enabled:    document.getElementById('apt-repo-enabled').checked,
    local_dir:  document.getElementById('apt-repo-local-dir').value,
  };
}

async function aptRepoSaveForm() {
  const idx = parseInt(document.getElementById('apt-repo-edit-index').value);
  const body = _aptFormData();
  if (!body.uri) { toast('URI is required', 'error'); return; }

  let d;
  if (idx >= 0) {
    d = await api(`/api/apt-repos/${idx}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    d = await api('/api/apt-repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (d.repo) {
    toast(idx >= 0 ? 'Repository updated' : 'Repository added', 'success');
    document.getElementById('apt-repo-form').style.display = 'none';
    loadAptRepos();
  } else {
    toast('Failed to save repository', 'error');
  }
}

async function aptRepoRemove(index) {
  if (!confirm('Delete this repository configuration?')) return;
  const d = await api(`/api/apt-repos/${index}`, { method: 'DELETE' });
  if (d.deleted) { toast('Repository removed', 'success'); loadAptRepos(); }
  else toast('Failed to remove', 'error');
}

/* ---------- Snippet (APT line / ELBE XML) ---------- */

async function aptRepoShowSnippet(index) {
  const [apt, xml] = await Promise.all([
    api(`/api/apt-repos/${index}/apt-line`),
    api(`/api/apt-repos/${index}/elbe-xml`),
  ]);
  document.getElementById('apt-repo-snippet-apt').value = apt.line || '';
  document.getElementById('apt-repo-snippet-xml').value = xml.xml || '';
  document.getElementById('apt-repo-snippet').style.display = 'block';
}

/* ---------- Detail view (local repos) ---------- */

async function aptRepoShowDetail(index) {
  _aptDetailIndex = index;
  const d = await api('/api/apt-repos');
  const r = (d.repos || [])[index];
  if (!r) return;

  document.getElementById('apt-repo-detail-title').textContent = r.label || 'Repository Details';

  // Status
  let statusHtml = '<div style="margin-bottom:.5rem">';
  statusHtml += r.exists
    ? '<span class="badge ok">Repo exists</span> '
    : '<span class="badge err">Repo not found</span> ';
  statusHtml += r.has_keys
    ? '<span class="badge ok">GPG keys OK</span> '
    : '<span class="badge warn">No GPG keys</span> ';
  statusHtml += r.has_index
    ? '<span class="badge ok">Bin index</span> '
    : '<span class="badge warn">No bin index</span> ';
  statusHtml += r.has_sources_index
    ? '<span class="badge ok">Src index</span> '
    : '<span class="badge warn">No src index</span> ';
  statusHtml += '</div>';
  statusHtml += '<p style="font-size:.78rem;color:var(--text-dim)">' + (r.local_dir || '—') + '</p>';
  document.getElementById('apt-repo-detail-status').innerHTML = statusHtml;

  // Binary packages
  const pkgEl = document.getElementById('apt-repo-detail-packages');
  let pkgHtml = '';
  if (r.packages && r.packages.length) {
    pkgHtml += '<h4 style="margin:.5rem 0 .25rem">Binary packages (' + r.package_count + ')</h4>';
    pkgHtml += '<table><thead><tr><th>Package</th><th>Size</th><th>Actions</th></tr></thead><tbody>';
    r.packages.forEach(p => {
      const sizeKB = (p.size / 1024).toFixed(1);
      pkgHtml += `<tr>
        <td style="font-family:monospace;font-size:.8rem">${p.name}</td>
        <td style="font-size:.8rem;color:var(--text-dim)">${sizeKB} KB</td>
        <td><button class="btn danger" onclick="aptRepoDetailDeletePkg('${p.name}')">Del</button></td>
      </tr>`;
    });
    pkgHtml += '</tbody></table>';
  } else {
    pkgHtml += '<p style="color:var(--text-dim)">No .deb packages in repository.</p>';
  }

  // Source packages
  if (r.source_packages && r.source_packages.length) {
    pkgHtml += '<h4 style="margin:.75rem 0 .25rem">Source packages (' + r.source_count + ')</h4>';
    pkgHtml += '<table><thead><tr><th>File</th><th>Size</th><th>Actions</th></tr></thead><tbody>';
    r.source_packages.forEach(p => {
      const sizeKB = (p.size / 1024).toFixed(1);
      pkgHtml += `<tr>
        <td style="font-family:monospace;font-size:.8rem">${p.name}</td>
        <td style="font-size:.8rem;color:var(--text-dim)">${sizeKB} KB</td>
        <td><button class="btn danger" onclick="aptRepoDetailDeletePkg('${p.name}')">Del</button></td>
      </tr>`;
    });
    pkgHtml += '</tbody></table>';
  }
  pkgEl.innerHTML = pkgHtml;

  document.getElementById('apt-repo-detail').style.display = 'block';
}

async function aptRepoDetailGenKeys() {
  if (_aptDetailIndex < 0) return;
  show('apt-repo-output', 'Generating GPG keys...');
  const d = await api(`/api/apt-repos/${_aptDetailIndex}/gen-keys`, { method: 'POST' });
  show('apt-repo-output', d);
  if (d.returncode === 0) toast('GPG keys generated', 'success');
  else toast('Key generation failed', 'error');
  aptRepoShowDetail(_aptDetailIndex);
}

async function aptRepoDetailRebuild() {
  if (_aptDetailIndex < 0) return;
  show('apt-repo-output', 'Rebuilding repository index...');
  const d = await api(`/api/apt-repos/${_aptDetailIndex}/rebuild`, { method: 'POST' });
  show('apt-repo-output', d);
  if (d.returncode === 0) toast('Repository rebuilt', 'success');
  else toast('Rebuild failed', 'error');
  aptRepoShowDetail(_aptDetailIndex);
}

async function aptRepoDetailUpload() {
  if (_aptDetailIndex < 0) return;
  const input = document.getElementById('apt-repo-detail-upload');
  if (!input || !input.files.length) { toast('Select a .deb file first', 'error'); return; }
  const form = new FormData();
  form.append('file', input.files[0]);
  const d = await api(`/api/apt-repos/${_aptDetailIndex}/upload`, { method: 'POST', body: form });
  if (d.filename) { toast('Uploaded ' + d.filename, 'success'); input.value = ''; }
  else toast('Upload failed', 'error');
  aptRepoShowDetail(_aptDetailIndex);
}

async function aptRepoDetailDeletePkg(name) {
  if (_aptDetailIndex < 0) return;
  if (!confirm('Delete package ' + name + '?')) return;
  const d = await api(`/api/apt-repos/${_aptDetailIndex}/delete-package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: name }),
  });
  if (d.deleted) toast('Deleted ' + name, 'success');
  else toast('Delete failed', 'error');
  aptRepoShowDetail(_aptDetailIndex);
}
