/* ==========================================================================
   ELBE UI – Packages view
   ========================================================================== */

// Currently selected package for actions
let _pkgActionsName = '';

async function loadPackages() {
  const d = await api('/api/packages');
  const el = document.getElementById('packages-list');
  if (!el) return;

  const packages = d.packages || [];
  if (!packages.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No packages found. Check the Packages directory in Settings, or create one from the Sources page.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>Name</th><th>Packaging</th><th>.deb Files</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  packages.forEach(p => {
    // Packaging status badges
    let status = '';
    if (p.has_debian) {
      status += '<span class="badge ok">debian/</span> ';
      if (p.has_control) status += '<span class="badge ok">control</span> ';
      if (p.has_rules) status += '<span class="badge ok">rules</span> ';
      if (p.has_changelog) status += '<span class="badge ok">changelog</span> ';
    } else {
      status += '<span class="badge err">No debian/</span>';
    }

    // .deb files
    let debInfo = '—';
    if (p.deb_files && p.deb_files.length) {
      debInfo = p.deb_files.map(d => {
        const sizeKB = (d.size / 1024).toFixed(1);
        return `<span style="font-family:monospace;font-size:.78rem">${d.name}</span> <span style="color:var(--text-dim)">(${sizeKB} KB)</span>`;
      }).join('<br>');
    }

    // Source package files (.dsc, .tar.*)
    let srcInfo = '';
    if (p.source_files && p.source_files.length) {
      srcInfo = '<br><span style="font-size:.72rem;color:var(--accent)">src:</span> ' +
        p.source_files.map(s => {
          const sizeKB = (s.size / 1024).toFixed(1);
          return `<span style="font-family:monospace;font-size:.72rem">${s.name}</span> <span style="color:var(--text-dim);font-size:.72rem">(${sizeKB} KB)</span>`;
        }).join(', ');
    }

    html += `<tr>
      <td style="font-weight:600;font-family:monospace">${p.name}</td>
      <td>${status}</td>
      <td>${debInfo}${srcInfo}</td>
      <td class="btn-row" style="border:0;flex-wrap:nowrap">
        <button class="btn" onclick="packageShowActions('${p.name}')" title="Build, add to repo, manage in XML">Manage</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function packageShowActions(name) {
  _pkgActionsName = name;
  document.getElementById('packages-actions-name').value = name;
  document.getElementById('packages-actions-title').textContent = name;
  document.getElementById('packages-actions').style.display = 'block';
  document.getElementById('packages-xml-pkglist').innerHTML = '';
  document.getElementById('packages-debian-editor').style.display = 'none';
  packageLoadXmlOptions();
  packageLoadRepoOptions();
  packageLoadDebianFiles();
  packageLoadDist();
}

/* ---------- Build .deb ---------- */

async function packageBuildDeb() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name) return;
  show('packages-output', `Building .deb for ${name}…`);
  toast('Building package… this may take a moment.', 'info', 5000);

  const d = await api('/api/packages/build-deb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package_name: name }),
  });

  show('packages-output', d);
  if (d.returncode === 0) {
    const debNames = (d.deb_files || []).map(f => f.name).join(', ');
    const srcNames = (d.source_files || []).map(f => f.name).join(', ');
    let msg = `Build succeeded: ${debNames || 'done'}`;
    if (srcNames) msg += ` | src: ${srcNames}`;
    toast(msg, 'success');
    loadPackages();
  } else {
    toast('Build failed – check output', 'error');
  }
}

/* ---------- Clean build artifacts ---------- */

async function packageClean() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name) return;
  if (!confirm(`Remove all build artifacts for "${name}"?\n\nThis will delete .deb, .buildinfo, .changes files and clean the debian/ build cache.`)) return;

  show('packages-output', `Cleaning build artifacts for ${name}…`);
  const d = await api('/api/packages/clean', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package_name: name }),
  });

  show('packages-output', d);
  const removed = (d.removed_files || []);
  if (removed.length) {
    toast(`Cleaned: ${removed.join(', ')}`, 'success');
  } else {
    toast('Clean done (no artefacts to remove)', 'info');
  }
  loadPackages();
}

/* ---------- Add to APT Repo ---------- */

async function packageLoadRepoOptions() {
  const d = await api('/api/apt-repos');
  const sel = document.getElementById('packages-repo-select');
  if (!sel) return;
  sel.innerHTML = '';
  (d.repos || []).forEach((r, i) => {
    if (r.local_dir) {
      sel.innerHTML += `<option value="${i}">${r.label || r.uri} ${r.enabled === false ? '(disabled)' : ''}</option>`;
    }
  });
  if (!sel.innerHTML) {
    sel.innerHTML = '<option value="">No local repos configured</option>';
  }
}

async function packageAddToRepo() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name) return;

  // Find the latest .deb for this package
  const pkgData = await api('/api/packages');
  const pkg = (pkgData.packages || []).find(p => p.name === name);
  if (!pkg || !pkg.deb_files || !pkg.deb_files.length) {
    toast('No .deb file found. Build the package first.', 'error');
    return;
  }

  const debPath = pkg.deb_files[pkg.deb_files.length - 1].path;
  const repoIdx = parseInt(document.getElementById('packages-repo-select').value) || 0;

  show('packages-output', `Adding ${debPath} to repo (with source files)…`);
  const d = await api('/api/packages/add-to-repo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deb_path: debPath, repo_index: repoIdx, include_sources: true }),
  });

  show('packages-output', d);
  if (d.copied) {
    const srcCount = (d.source_files || []).length;
    const msg = srcCount
      ? `Package + ${srcCount} source file(s) added to repo & index rebuilt`
      : 'Package added to repo & index rebuilt (no source files found)';
    toast(msg, 'success');
  } else {
    toast('Failed to add to repo', 'error');
  }
}

/* ---------- Manage in XML project ---------- */

async function packageLoadXmlOptions() {
  const d = await api('/api/xml/list');
  const sel = document.getElementById('packages-xml-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- select a project --</option>';
  (d.files || []).forEach(f => {
    sel.innerHTML += `<option value="${f.path}">${f.name}</option>`;
  });

  // Load pkg-list when selection changes
  sel.onchange = async function () {
    const xmlPath = sel.value;
    const el = document.getElementById('packages-xml-pkglist');
    if (!xmlPath) { el.innerHTML = ''; return; }
    const data = await api(`/api/packages/xml-pkg-list?xml_path=${encodeURIComponent(xmlPath)}`);
    if (data.packages && data.packages.length) {
      el.innerHTML = '<strong>Current pkg-list:</strong> ' + data.packages.map(p => `<code>${p}</code>`).join(', ');
    } else {
      el.innerHTML = '<em>No packages in pkg-list</em>';
    }
  };
}

async function packageAddToXml() {
  const name = document.getElementById('packages-actions-name').value;
  const xmlPath = document.getElementById('packages-xml-select').value;
  if (!name || !xmlPath) { toast('Select a project first', 'error'); return; }

  const d = await api('/api/packages/manage-in-xml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml_path: xmlPath, package_name: name, action: 'add' }),
  });

  if (d.changed) toast(`${name} added to project`, 'success');
  else toast(d.message || d.error || 'No change', 'info');
  show('packages-output', d);

  // Refresh pkg-list display
  document.getElementById('packages-xml-select').onchange();
}

async function packageRemoveFromXml() {
  const name = document.getElementById('packages-actions-name').value;
  const xmlPath = document.getElementById('packages-xml-select').value;
  if (!name || !xmlPath) { toast('Select a project first', 'error'); return; }

  const d = await api('/api/packages/manage-in-xml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml_path: xmlPath, package_name: name, action: 'remove' }),
  });

  if (d.changed) toast(`${name} removed from project`, 'success');
  else toast(d.message || d.error || 'No change', 'info');
  show('packages-output', d);

  // Refresh pkg-list display
  document.getElementById('packages-xml-select').onchange();
}

/* ---------- Debian files editor ---------- */

// Track which debian file is currently being edited
let _debianEditingFile = '';

async function packageLoadDebianFiles() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name) return;
  const el = document.getElementById('packages-debian-files');
  const countEl = document.getElementById('packages-debian-count');
  const detailsEl = document.getElementById('packages-debian-details');
  el.innerHTML = '<em>Loading…</em>';

  const d = await api(`/api/packages/${encodeURIComponent(name)}/debian`);
  const files = d.files || [];
  countEl.textContent = files.length ? `${files.length} file(s)` : '';

  if (!files.length) {
    el.innerHTML = '<em>No debian/ files found</em>';
    return;
  }

  // Auto-open when there are files
  detailsEl.open = true;

  let html = '<table style="font-size:.82rem">' +
    '<colgroup><col class="col-file"><col class="col-size"><col class="col-actions"></colgroup>' +
    '<thead><tr><th>File</th><th>Size</th><th>Actions</th></tr></thead><tbody>';

  files.forEach(f => {
    const sizeKB = (f.size / 1024).toFixed(1);
    const icon = f.editable ? '📝' : '📄';
    const action = f.editable
      ? `<button class="btn secondary" style="font-size:.68rem;padding:.1rem .4rem" onclick="packageEditDebianFile('${name}', '${f.name}')">✏️ Edit</button>`
      : '<span class="badge" style="font-size:.68rem;opacity:.6">read-only</span>';
    html += `<tr>
      <td style="font-family:monospace;font-size:.75rem" title="${f.name}">${icon} ${f.name}</td>
      <td>${sizeKB} KB</td>
      <td>${action}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

async function packageEditDebianFile(pkgName, fileName) {
  const el = document.getElementById('packages-debian-editor');
  const titleEl = document.getElementById('packages-debian-editor-title');
  const contentEl = document.getElementById('packages-debian-editor-content');

  titleEl.textContent = `debian/${fileName}`;
  contentEl.value = 'Loading…';
  el.style.display = 'block';
  _debianEditingFile = fileName;

  const d = await api(`/api/packages/${encodeURIComponent(pkgName)}/debian/${encodeURIComponent(fileName)}`);
  if (d.content !== undefined) {
    contentEl.value = d.content;
  } else {
    contentEl.value = `Error: ${d.detail || 'Could not load file'}`;
  }
}

async function packageSaveDebianFile() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name || !_debianEditingFile) return;

  const content = document.getElementById('packages-debian-editor-content').value;
  const d = await api(`/api/packages/${encodeURIComponent(name)}/debian/${encodeURIComponent(_debianEditingFile)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (d.size !== undefined) {
    toast(`Saved debian/${_debianEditingFile} (${d.size} bytes)`, 'success');
  } else {
    toast(`Error saving: ${d.detail || 'unknown error'}`, 'error');
  }
  show('packages-output', d);
}

/* ---------- dist/ files ---------- */

async function packageLoadDist() {
  const name = document.getElementById('packages-actions-name').value;
  if (!name) return;
  const el = document.getElementById('packages-dist-files');
  const countEl = document.getElementById('packages-dist-count');
  const detailsEl = document.getElementById('packages-dist-details');
  el.innerHTML = '<em>Loading…</em>';

  const d = await api(`/api/packages/${encodeURIComponent(name)}/dist`);
  const files = d.files || [];
  countEl.textContent = files.length ? `${files.length} file(s)` : 'empty';

  if (!files.length) {
    el.innerHTML = '<em>No build artefacts yet. Build the package first.</em>';
    return;
  }

  // Auto-open when there are files
  detailsEl.open = true;

  const typeIcons = {
    deb: '📦', dsc: '📄', 'source-tarball': '🗜️',
    buildinfo: 'ℹ️', changes: '📋', other: '📎',
  };

  let html = '<table style="font-size:.82rem">' +
    '<colgroup><col class="col-file"><col class="col-size"><col class="col-actions"></colgroup>' +
    '<thead><tr><th>File</th><th>Size</th><th>Actions</th></tr></thead><tbody>';

  files.forEach(f => {
    const sizeKB = (f.size / 1024).toFixed(1);
    const icon = typeIcons[f.type] || '📎';
    const dlUrl = `/api/packages/${encodeURIComponent(name)}/dist/${encodeURIComponent(f.name)}`;
    html += `<tr>
      <td style="font-family:monospace;font-size:.75rem" title="${f.name}">${icon} ${f.name}</td>
      <td>${sizeKB} KB</td>
      <td><a href="${dlUrl}" target="_blank" class="btn secondary" style="font-size:.68rem;padding:.1rem .4rem;text-decoration:none">⬇ Download</a></td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}