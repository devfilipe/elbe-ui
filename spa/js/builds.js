/* ==========================================================================
   ELBE UI – Local Builds view (Submit Jobs + Build Outputs)
   ========================================================================== */

let _buildsLogInterval = null;
let _buildsJobsInterval = null;

/* ---------- Submit Jobs ---------- */

async function buildsLoadJobs() {
  const d = await api('/api/submit/jobs');
  const el = document.getElementById('builds-jobs-list');
  if (!el) return;

  const jobs = d.jobs || [];
  if (!jobs.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No submit jobs yet. Use the Submit Build page to start one.</p>';
    buildsStopAutoJobs();
    return;
  }

  // Auto-refresh the table while any job is still active
  const hasActive = jobs.some(j => j.status === 'running' || j.status === 'queued');
  if (hasActive && !_buildsJobsInterval) {
    _buildsJobsInterval = setInterval(() => buildsLoadJobs(), 4000);
  } else if (!hasActive) {
    buildsStopAutoJobs();
  }

  let html = '<table><thead><tr>' +
    '<th>ID</th><th>Project</th><th>Status</th><th>PID</th><th>Duration</th><th>Log</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  jobs.forEach(j => {
    let badge = 'dim';
    if (j.status === 'running') badge = 'ok';
    else if (j.status === 'queued') badge = 'warn';
    else if (j.status === 'success') badge = 'ok';
    else if (j.status === 'partial') badge = 'warn';
    else if (j.status === 'failed' || j.status === 'cancelled') badge = 'err';

    let statusLabel = j.status;
    let statusTitle = '';
    if (j.status === 'queued') {
      const pos = jobs.filter(x => x.status === 'queued').indexOf(j) + 1;
      statusLabel = `queued (#${pos})`;
    } else if (j.status === 'partial') {
      statusLabel = 'partial ⚠';
      statusTitle = 'ELBE reported build_failed but artifacts were recovered. The disk image is likely usable — check log.txt for non-critical errors (e.g. missing source packages for source CD).';
    }
    const statusBadge = `<span class="badge ${badge}" ${statusTitle ? 'title="' + statusTitle + '" style="cursor:help"' : ''}>${statusLabel}</span>`;

    let duration = '—';
    if (j.started_at) {
      const end = j.finished_at || (Date.now() / 1000);
      const secs = Math.round(end - j.started_at);
      if (secs >= 3600) {
        const hrs = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        duration = `${hrs}h ${mins}m`;
      } else if (secs >= 60) {
        const mins = Math.floor(secs / 60);
        duration = `${mins}m ${secs % 60}s`;
      } else {
        duration = `${secs}s`;
      }
    }

    const pid = j.pid ? `<span style="font-family:monospace">${j.pid}</span>` : '—';
    const logLines = j.log_lines || 0;
    const logInfo = `<span style="font-size:.78rem;color:var(--text-dim)">${logLines} lines</span>`;

    let actions = `<button class="btn secondary" onclick="buildsShowLog('${j.id}','${j.xml_name}')" title="View log" style="font-size:.78rem;padding:2px 8px">📄 Log</button>`;
    if (j.status === 'running' || j.status === 'queued') {
      actions += ` <button class="btn danger" onclick="buildsCancelJob('${j.id}')" title="Kill process" style="font-size:.78rem;padding:2px 8px">⛔ Kill</button>`;
    } else {
      // For failed/partial jobs with an initvm project still available
      if ((j.status === 'failed' || j.status === 'partial') && j.initvm_build_dir) {
        actions += ` <button class="btn secondary" onclick="buildsDownloadFiles('${j.id}')" title="Download build artifacts from initvm" style="font-size:.78rem;padding:2px 8px">⬇ Download</button>`;
        actions += ` <button class="btn secondary" onclick="buildsCleanupInitvm('${j.id}')" title="Remove project from initvm" style="font-size:.78rem;padding:2px 8px">🧹 Cleanup</button>`;
      }
      actions += ` <button class="btn danger" onclick="buildsRemoveJob('${j.id}')" title="Remove from list" style="font-size:.78rem;padding:2px 8px">✕</button>`;
    }

    // Extract initvm UUID from path like /var/cache/elbe/<uuid>
    let initvmId = '';
    if (j.initvm_build_dir) {
      const parts = j.initvm_build_dir.split('/');
      initvmId = parts[parts.length - 1] || '';
    }
    const initvmLine = initvmId
      ? `<br><span style="font-size:.68rem;color:var(--text-dim)" title="InitVM project: ${j.initvm_build_dir}">↳ ${initvmId.substring(0,13)}…</span>`
      : '';

    html += `<tr>
      <td style="font-family:monospace;font-size:.78rem">${j.id}${initvmLine}</td>
      <td title="${j.xml_path || ''}">${j.xml_name || j.xml_path}</td>
      <td>${statusBadge}</td>
      <td style="font-size:.78rem">${pid}</td>
      <td>${duration}</td>
      <td>${logInfo}</td>
      <td class="btn-row" style="border:0;margin:0;padding:0">${actions}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function buildsStopAutoJobs() {
  if (_buildsJobsInterval) { clearInterval(_buildsJobsInterval); _buildsJobsInterval = null; }
}

async function buildsShowLog(jobId, title) {
  document.getElementById('builds-log-viewer').style.display = 'block';
  document.getElementById('builds-log-title').textContent = title || jobId;
  document.getElementById('builds-log-jobid').value = jobId;
  await buildsRefreshLog();

  // Auto-refresh every 2 seconds
  buildsStopAutoLog();
  _buildsLogInterval = setInterval(async () => {
    const d = await api(`/api/submit/jobs/${jobId}`);
    if (d.status && d.status !== 'running' && d.status !== 'queued') {
      buildsStopAutoLog();
      buildsLoadJobs();
    }
    await buildsRefreshLog();
  }, 2000);
}

async function buildsRefreshLog() {
  const jobId = document.getElementById('builds-log-jobid').value;
  if (!jobId) return;
  const d = await api(`/api/submit/jobs/${jobId}/log`);
  const pre = document.getElementById('builds-log-content');
  pre.textContent = d.log || '(no output yet — waiting for elbe submit to produce output…)';
  if (document.getElementById('builds-log-autoscroll').checked) {
    pre.scrollTop = pre.scrollHeight;
  }
}

function buildsStopAutoLog() {
  if (_buildsLogInterval) {
    clearInterval(_buildsLogInterval);
    _buildsLogInterval = null;
  }
}

async function buildsCancelJob(jobId) {
  if (!confirm('Kill this submit process?')) return;
  const d = await api(`/api/submit/jobs/${jobId}/cancel`, { method: 'POST' });
  if (d.cancelled) toast('Job killed', 'success');
  else toast(d.reason || 'Failed to kill', 'error');
  buildsLoadJobs();
}

async function buildsRemoveJob(jobId) {
  const d = await api(`/api/submit/jobs/${jobId}/remove`, { method: 'POST' });
  if (d.removed) toast('Job removed', 'success');
  buildsLoadJobs();
}

async function buildsDownloadFiles(jobId) {
  toast('Downloading build artifacts from initvm…', 'info', 5000);
  const d = await api(`/api/submit/jobs/${jobId}/download-files`, { method: 'POST' });
  if (d.downloaded) {
    toast(`Downloaded ${d.files.length} file(s) to ${d.output_dir}`, 'success', 5000);
  } else {
    toast(d.reason || 'Download failed', 'error');
  }
  buildsLoadJobs();
  buildsLoadOutputs();
}

async function buildsCleanupInitvm(jobId) {
  if (!confirm('Remove this project from the initvm? Make sure you have downloaded the files first.')) return;
  const d = await api(`/api/submit/jobs/${jobId}/cleanup-initvm`, { method: 'POST' });
  if (d.cleaned) {
    toast(`Cleaned up initvm project: ${d.initvm_dir}`, 'success');
  } else {
    toast(d.reason || 'Cleanup failed', 'error');
  }
  buildsLoadJobs();
}

/* ---------- Build Outputs ---------- */

async function buildsLoadOutputs() {
  const d = await api('/api/builds');
  const el = document.getElementById('builds-list');
  if (!el) return;

  const builds = d.builds || [];
  if (!builds.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No local builds found.</p>';
    return;
  }

  // Remember which builds are currently open so we preserve state on refresh
  const openSet = new Set();
  el.querySelectorAll('details.section-collapse[open]').forEach(det => {
    const key = det.dataset.buildPath;
    if (key) openSet.add(key);
  });
  // On first load (nothing rendered yet), open the first build by default
  const firstLoad = !el.children.length;

  el.innerHTML = builds.map((b, idx) => {
    const files = b.files || [];
    const sizeTotal = files.reduce((a, f) => a + (f.size || 0), 0);
    const sizeMB = (sizeTotal / 1048576).toFixed(1);
    const fileCount = files.length;

    let fileRows = files.map(f => {
      const fSizeKB = ((f.size || 0) / 1024).toFixed(1);
      const fSizeMB = ((f.size || 0) / 1048576).toFixed(1);
      const sizeLabel = f.size >= 1048576 ? `${fSizeMB} MB` : `${fSizeKB} KB`;
      const isImage = f.name.endsWith('.img') || f.name.endsWith('.qcow2');
      const isCompressed = f.name.endsWith('.img.tar.xz') || f.name.endsWith('.img.tar.gz') || f.name.endsWith('.img.gz');
      const isViewable = /\.(txt|xml|log|html?|csv|json|ya?ml)$/i.test(f.name);
      let actions = '';
      if (isViewable) {
        actions += `<button class="btn secondary" onclick="buildsViewFile('${b.path}','${f.name}')" style="font-size:.72rem;padding:2px 6px" title="View file contents">👁 View</button> `;
      }
      if (isCompressed) {
        actions += `<button class="btn secondary" onclick="buildsExtract('${b.path}','${f.name}')" style="font-size:.72rem;padding:2px 6px" title="Extract to raw .img for QEMU / SD card">📦 Extract</button> `;
      }
      if (isImage) {
        actions += `<button class="btn secondary" onclick="simCreateFromImage('${b.path}/${f.name}','${f.name}','${b.name}')" style="font-size:.72rem;padding:2px 6px">▷ Simulator</button>`;
      }
      return `<tr>
        <td style="font-family:monospace;font-size:.78rem" title="${f.name}">${f.name}</td>
        <td style="font-size:.78rem;color:var(--text-dim);white-space:nowrap">${sizeLabel}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');

    // Mapping info: job ID ↔ initvm project UUID
    let mappingParts = [];
    if (b.job_id) mappingParts.push(`Job: <code>${b.job_id}</code>`);
    if (b.job_status) {
      let badge = 'dim';
      let statusTip = '';
      if (b.job_status === 'success') badge = 'ok';
      else if (b.job_status === 'partial') {
        badge = 'warn';
        statusTip = ' title="ELBE reported errors but artifacts were recovered — image is likely usable" style="cursor:help"';
      }
      else if (b.job_status === 'failed') badge = 'err';
      mappingParts.push(`<span class="badge ${badge}"${statusTip}>${b.job_status}${b.job_status === 'partial' ? ' ⚠' : ''}</span>`);
    }
    if (b.initvm_project) {
      const uuid = b.initvm_project.replace('/var/cache/elbe/', '');
      mappingParts.push(`InitVM: <code title="${b.initvm_project}">${uuid}</code>`);
    }
    const mappingHtml = mappingParts.length
      ? `<div style="font-size:.72rem;color:var(--text-dim);margin-top:.25rem">${mappingParts.join(' · ')}</div>`
      : '';

    // Summary line: name + stats badge + delete button
    const summaryStats = `<span style="font-size:.72rem;color:var(--text-dim);margin-left:auto;white-space:nowrap">${fileCount} files · ${sizeMB} MB</span>`;
    const deleteBtn = `<button class="btn danger" onclick="event.stopPropagation();buildsDelete('${b.path}')" style="font-size:.72rem;padding:2px 8px;margin-left:.5rem" title="Delete build">✕</button>`;

    // Open by default: first load → first item; otherwise preserve previous state
    const isOpen = firstLoad ? idx === 0 : openSet.has(b.path);

    return `<details class="section-collapse" data-build-path="${b.path}" ${isOpen ? 'open' : ''}>
      <summary>
        ${b.name}
        ${summaryStats}
        ${deleteBtn}
      </summary>
      <div class="section-collapse-body">
        ${mappingHtml}
        <table style="margin-top:.25rem"><thead><tr><th>File</th><th>Size</th><th></th></tr></thead>
          <tbody>${fileRows}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');
}

async function buildsExtract(buildPath, filename) {
  toast('Extracting image…', 'info', 3000);
  const d = await api('/api/builds/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_path: buildPath, filename }),
  });
  if (d.extracted) {
    const sizeMB = d.size ? (d.size / 1048576).toFixed(1) + ' MB' : '';
    toast(`Extracted: ${d.extracted} ${sizeMB}`, 'success');
  } else {
    toast(d.error || 'Extract failed', 'error');
  }
  buildsLoadOutputs();
}

async function buildsDelete(path) {
  if (!confirm(`Delete local build ${path}?`)) return;
  const d = await api('/api/builds/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (d.deleted) toast('Build deleted', 'success');
  else toast('Delete failed', 'error');
  buildsLoadOutputs();
}

// Backward compat
function loadBuilds() { buildsLoadJobs(); buildsLoadOutputs(); }

/* ---------- File Viewer ---------- */

async function buildsViewFile(buildPath, filename) {
  const viewer = document.getElementById('builds-file-viewer');
  const titleEl = document.getElementById('builds-file-viewer-title');
  const pre = document.getElementById('builds-file-viewer-content');

  viewer.style.display = 'block';
  titleEl.textContent = filename;
  pre.textContent = 'Loading…';

  const d = await api('/api/builds/read-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ build_path: buildPath, filename }),
  });

  if (d.content !== undefined) {
    const sizeMB = (d.size / 1048576).toFixed(2);
    titleEl.textContent = `${filename}  (${sizeMB} MB)${d.truncated ? '  ⚠ truncated to 2 MB' : ''}`;
    // For XML files, show with basic syntax hint
    pre.textContent = d.content;
  } else {
    pre.textContent = d.detail || d.error || 'Failed to load file';
  }

  // Scroll the viewer into view
  viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildsCloseFileViewer() {
  document.getElementById('builds-file-viewer').style.display = 'none';
  document.getElementById('builds-file-viewer-content').textContent = '';
}
