/* ==========================================================================
   ELBE UI – XML Editor view
   ========================================================================== */

async function loadXmlPage() {
  const d = await api('/api/xml/list');
  const el = document.getElementById('xml-list');
  if (!el) return;
  if (!d.files || !d.files.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No projects found. Check the ELBE Projects directory in Settings.</p>';
    return;
  }
  el.innerHTML = '<table><thead><tr><th>Name</th><th>Directory</th><th>Actions</th></tr></thead><tbody>' +
    d.files.map(f => `<tr>
      <td style="font-family:monospace">${f.name}</td>
      <td style="font-size:.78rem;color:var(--text-dim)">${f.dir}</td>
      <td class="btn-row" style="border:0">
        <button class="btn secondary" onclick="xmlEdit('${f.path}')">Edit</button>
        <button class="btn secondary" onclick="xmlValidate('${f.path}')">Validate</button>
        <button class="btn" onclick="xmlSubmit('${f.path}')">Submit</button>
      </td>
    </tr>`).join('') + '</tbody></table>';
}

async function xmlEdit(path) {
  const d = await api('/api/xml/read', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (d.error) { toast(d.error, 'error'); return; }

  document.getElementById('xml-editor-path').value = d.path;
  document.getElementById('xml-editor-textarea').value = d.content;
  document.getElementById('xml-editor-section').style.display = 'block';
  document.getElementById('xml-editor-output').style.display = 'none';
}

async function xmlSave() {
  const path = document.getElementById('xml-editor-path').value;
  const content = document.getElementById('xml-editor-textarea').value;
  const d = await api('/api/xml/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (d.size) toast(`Saved (${d.size} bytes)`, 'success');
  else toast('Save failed', 'error');
}

async function xmlValidateEditor() {
  const path = document.getElementById('xml-editor-path').value;
  await xmlValidate(path);
}

async function xmlValidate(path) {
  const d = await api('/api/xml/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const out = document.getElementById('xml-editor-output') || document.getElementById('xml-validate-output');
  if (out) {
    out.style.display = 'block';
    out.textContent = d.returncode === 0
      ? '✓ Validation passed\n' + (d.stdout || '')
      : '✗ Validation errors:\n' + (d.stderr || d.stdout || '');
  }
  if (d.returncode === 0) toast('XML is valid', 'success');
  else toast('Validation errors found', 'error');
}

async function xmlSubmit(path) {
  if (!confirm(`Submit build for ${path}?`)) return;
  toast('Submitting build…', 'info', 3000);
  const d = await api('/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml_path: path }),
  });
  const out = document.getElementById('xml-editor-output');
  if (d.job_id) {
    let msg = `Build queued! Job ID: ${d.job_id}`;
    if (d.queued > 0) msg += ` (${d.queued} in queue, ${d.running}/${d.max} running)`;
    if (out) { out.style.display = 'block'; out.textContent = msg; }
    toast(msg + ' – see Local Builds', 'success', 5000);
    setTimeout(() => {
      navigateTo('builds');
      buildsShowLog(d.job_id, '');
    }, 1500);
  } else {
    if (out) { out.style.display = 'block'; out.textContent = JSON.stringify(d, null, 2); }
    toast(d.detail || d.error || 'Failed to submit build', 'error');
  }
}

async function xmlNewFile() {
  const name = prompt('New XML filename (e.g. my-image.xml):');
  if (!name) return;
  const settings = await api('/api/settings');
  const dir = settings.projects_dir || '/workspace/images';
  const path = dir + '/' + name;
  const template = `<?xml version="1.0" encoding="utf-8"?>
<RootFileSystemImage>
  <project>
    <name>New Project</name>
    <version>1.0</version>
    <suite>bookworm</suite>
    <architecture>amd64</architecture>
    <description>Created via ELBE UI</description>
  </project>

  <mirror>
    <primary_host>deb.debian.org</primary_host>
    <primary_path>/debian</primary_path>
    <primary_proto>http</primary_proto>
  </mirror>

  <target>
    <hostname>elbe-target</hostname>
    <domain>local</domain>
    <passwd>root</passwd>
    <console>ttyS0,115200</console>
    <package>
      <tar>
        <name>rootfs.tgz</name>
      </tar>
    </package>
    <pkg-list>
      <pkg>bash</pkg>
    </pkg-list>
  </target>
</RootFileSystemImage>`;

  const d = await api('/api/xml/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: template }),
  });
  if (d.size) { toast('File created', 'success'); xmlEdit(path); loadXmlPage(); }
  else toast('Failed to create file', 'error');
}
