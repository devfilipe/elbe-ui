/* ==========================================================================
   ELBE UI – Sources view
   ========================================================================== */

async function loadSources() {
  const d = await api('/api/sources');
  const el = document.getElementById('sources-list');
  if (!el) return;

  const sources = d.sources || [];
  if (!sources.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No source projects found. Check the Sources directory in Settings.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>Name</th><th>Build System</th><th>Files</th><th>Package</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  sources.forEach(s => {
    // Detect build system
    let buildSys = '—';
    if (s.has_makefile) buildSys = '<code>Makefile</code>';
    else if (s.has_cmake) buildSys = '<code>CMake</code>';

    // Package status
    const pkgStatus = s.has_package
      ? `<span class="badge ok">${s.package_name}</span>`
      : '<span class="badge warn">None</span>';

    // Files (abbreviated)
    const fileList = s.files.slice(0, 5).join(', ') + (s.files.length > 5 ? '…' : '');

    html += `<tr>
      <td style="font-weight:600;font-family:monospace">${s.name}</td>
      <td>${buildSys}</td>
      <td style="font-size:.78rem;color:var(--text-dim)">${fileList}</td>
      <td>${pkgStatus}</td>
      <td class="btn-row" style="border:0;flex-wrap:nowrap">
        ${s.has_package
          ? `<button class="btn secondary" onclick="navigateTo('packages')" title="Go to package">→ Pkg</button>`
          : `<button class="btn" onclick="sourcesShowCreatePkg('${s.name}', '${s.package_name}')" title="Create package template">+ Package</button>`
        }
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function sourcesShowCreatePkg(srcName, suggestedPkgName) {
  document.getElementById('sources-create-src-name').value = srcName;
  document.getElementById('sources-create-pkg-name').value = suggestedPkgName;
  document.getElementById('sources-create-pkg-desc').value = '';
  document.getElementById('sources-create-pkg').style.display = 'block';
  // Auto-fill maintainer from Maintainer settings
  api('/api/maintainer').then(m => {
    const formatted = (m.name && m.email) ? `${m.name} <${m.email}>` : '';
    const el = document.getElementById('sources-create-pkg-maintainer');
    if (el && formatted) el.value = formatted;
  });
}

async function sourcesCreatePackage() {
  const srcName = document.getElementById('sources-create-src-name').value;
  const body = {
    source_name: srcName,
    package_name: document.getElementById('sources-create-pkg-name').value,
    description: document.getElementById('sources-create-pkg-desc').value,
    version: document.getElementById('sources-create-pkg-version').value,
    maintainer: document.getElementById('sources-create-pkg-maintainer').value,
    architecture: document.getElementById('sources-create-pkg-arch').value,
  };

  show('sources-output', 'Creating package template…');
  const d = await api('/api/sources/create-package', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (d.package_name) {
    toast(`Package ${d.package_name} created`, 'success');
    show('sources-output', d);
    document.getElementById('sources-create-pkg').style.display = 'none';
    loadSources();
  } else {
    toast('Failed to create package', 'error');
    show('sources-output', d);
  }
}
