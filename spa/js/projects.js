/* ==========================================================================
   ELBE UI – Projects view
   ========================================================================== */

function showProjectsOutput(label, data) {
  document.getElementById('projects-output-label').textContent = label;
  document.getElementById('projects-output-panel').style.display = 'block';
  show('projects-output', data);
}

async function loadProjects() {
  const d = await api('/api/projects');
  const tbody = document.getElementById('projects-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (d.projects && d.projects.length) {
    d.projects.forEach(p => {
      let cls, statusLabel, statusTitle = '';
      if (p.status === 'build_done') {
        cls = 'ok';
        statusLabel = 'build_done';
      } else if (p.status === 'busy') {
        cls = 'warn';
        statusLabel = 'busy';
      } else if (p.status === 'build_failed') {
        cls = 'warn';
        statusLabel = 'build_failed ⚠';
        statusTitle = 'The ELBE daemon reports build_failed, but the disk image may have been generated successfully. Common non-critical failures include: missing source packages for the source CD. Check the log.txt and validation.txt for details.';
      } else if (p.status === 'needs_build') {
        cls = 'dim';
        statusLabel = 'needs_build';
      } else {
        cls = 'err';
        statusLabel = p.status;
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:monospace;font-size:.76rem">${p.build_dir}</td>
        <td>${p.name}</td><td>${p.version}</td>
        <td><span class="badge ${cls}" ${statusTitle ? 'title="' + statusTitle + '" style="cursor:help"' : ''}>${statusLabel}</span></td>
        <td class="btn-row" style="border:0">
          <button class="btn secondary" onclick="projectSetXml('${p.build_dir}')">Set XML</button>
          <button class="btn" onclick="buildProject('${p.build_dir}')">Build</button>
          <button class="btn secondary" onclick="getProjectFiles('${p.build_dir}')">Files</button>
          <button class="btn secondary" onclick="downloadAllFiles('${p.build_dir}')">↓ All</button>
          <button class="btn danger" onclick="deleteProject('${p.build_dir}')">Del</button>
        </td>`;
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim)">No projects found. Make sure InitVM is running.</td></tr>';
  }
  if (d.error) showProjectsOutput('Error', d.error);
}

async function createProject() {
  const d = await api('/api/projects/create', { method: 'POST' });
  if (d.build_dir) toast(`Project created: ${d.build_dir}`, 'success');
  else toast('Failed to create project', 'error');
  showProjectsOutput('Create project', d);
  loadProjects();
}

async function projectSetXml(dir) {
  const xmlPath = prompt('Enter path to XML file on the server:');
  if (!xmlPath) return;
  const d = await api('/api/projects/set_xml', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_dir: dir, xml_path: xmlPath }),
  });
  showProjectsOutput('Set XML', d);
  if (d.returncode === 0) toast('XML set successfully', 'success');
  loadProjects();
}

async function buildProject(dir) {
  showProjectsOutput('Build', `Triggering build for ${dir}…`);
  const d = await api('/api/projects/build', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_dir: dir }),
  });
  showProjectsOutput('Build', d);
  if (d.returncode === 0) toast('Build triggered', 'success');
  else toast('Build trigger failed', 'error');
  loadProjects();
}

async function getProjectFiles(dir) {
  const d = await api(`/api/projects/${encodeURIComponent(dir)}/files`);
  showProjectsOutput('Files', d);
}

async function downloadAllFiles(dir) {
  showProjectsOutput('Download all', `Downloading files from ${dir}…`);
  const d = await api('/api/projects/download_all', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_dir: dir }),
  });
  showProjectsOutput('Download all', d);
  if (d.returncode === 0) toast('Files downloaded', 'success');
  else toast('Download failed', 'error');
}

async function deleteProject(dir) {
  if (!confirm(`Delete project ${dir}?`)) return;
  const delLocal = confirm('Also delete local files on disk?');
  const d = await api('/api/projects/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_dir: dir, delete_local: delLocal }),
  });
  showProjectsOutput('Delete project', d);
  toast('Project deleted', 'success');
  loadProjects();
}

async function deleteAllProjects() {
  if (!confirm('Delete ALL projects from the initvm?')) return;
  const d = await api('/api/projects/delete_all', { method: 'POST' });
  showProjectsOutput('Delete all', d);
  toast('All projects deleted', 'success');
  loadProjects();
}

async function purgeAllProjects() {
  if (!confirm('PURGE all projects (including busy ones)?\nThis will reset + delete every project in the initvm.')) return;
  toast('Purging all projects…', 'info', 3000);
  const d = await api('/api/projects/purge_all', { method: 'POST' });
  showProjectsOutput('Purge all', d);
  const n = (d.deleted || []).length;
  const e = (d.errors || []).length;
  if (e === 0) toast(`Purged ${n} project(s)`, 'success');
  else toast(`Purged ${n}, ${e} error(s)`, 'error');
  loadProjects();
}
