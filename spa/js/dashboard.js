/* ==========================================================================
   ELBE UI – Dashboard view (multi-VM manager)
   ========================================================================== */

let _statusPollTimer = null;

/* ---------- VM list ---------- */

async function vmLoad() {
  const el = document.getElementById('vm-list');
  if (!el) return;
  el.innerHTML = 'Loading… <span class="spinner"></span>';
  const d = await api('/api/initvms');

  if (d.error) {
    el.innerHTML = `<p style="color:var(--err)">Error loading VMs: ${d.error}</p>`;
    return;
  }

  const vms = d.vms || [];
  const maxVms = d.max_vms || 1;

  // Show/hide the New VM button based on limit
  const newVmBtn = document.getElementById('vm-new-btn');
  if (newVmBtn) newVmBtn.style.display = vms.length < maxVms ? '' : 'none';

  if (!vms.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No VMs configured. The default initvm may still be initializing.</p>';
    return;
  }

  let html = '';

  let anyTransitioning = false;

  vms.forEach((vm, idx) => {
    const transitioning = vm.qemu_running && !vm.soap_reachable;
    if (transitioning) anyTransitioning = true;

    const qemuBadge = vm.qemu_running
      ? '<span class="badge ok">QEMU Running</span>'
      : '<span class="badge dim">QEMU Stopped</span>';
    const soapBadge = vm.soap_reachable
      ? '<span class="badge ok">SOAP Daemon OK</span>'
      : (vm.qemu_running
          ? '<span class="badge warn">SOAP Unreachable</span>'
          : '<span class="badge dim">SOAP Daemon Offline</span>');
    const progressNote = transitioning
      ? `<span style="font-size:.78rem;color:var(--text-dim);margin-left:.25rem">
           Initialization in progress — SOAP daemon not ready yet.
         </span>`
      : '';
    const dirShort = vm.path.split('/').slice(-2).join('/');

    let actions = '';
    if (vm.qemu_running) {
      if (transitioning) {
        actions += `<button class="btn secondary" onclick="vmViewLog('${vm.name}')">📋 View Log</button> `;
      } else {
        actions += `<button class="btn secondary" onclick="vmElbeStatus('${vm.name}')">Status</button> `;
        actions += `<button class="btn secondary" onclick="vmViewLog('${vm.name}')">📋 Log</button> `;
      }
      actions += `<button class="btn danger" onclick="vmStop('${vm.name}')">⏹ Stop</button>`;
    } else {
      actions += `<button class="btn" onclick="vmStart('${vm.name}')">▶ Start</button> `;
      actions += `<button class="btn secondary" onclick="vmViewLog('${vm.name}')">📋 Log</button> `;
      actions += `<button class="btn danger" onclick="vmDelete('${vm.name}')">✕ Remove</button>`;
    }

    html += `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:.25rem">
        <div>
          <div style="font-weight:600;font-size:1rem;margin-bottom:.4rem">${vm.name}
            <span style="font-family:monospace;font-size:.75rem;color:var(--text-dim);font-weight:400;margin-left:.5rem" title="${vm.path}">…/${dirShort} · port ${vm.soap_port}</span>
          </div>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
            ${qemuBadge}
            ${soapBadge}
            ${progressNote}
          </div>
        </div>
        <div class="btn-row">${actions}</div>
      </div>`;

    if (idx < vms.length - 1) {
      html += '<hr style="border:0;border-top:1px solid var(--border);margin:.75rem 0">';
    }
  });

  el.innerHTML = html;

  // Auto-refresh every 10s while any VM is initializing
  if (anyTransitioning) {
    if (!_statusPollTimer) _startStatusPoll(10000, 60);
  } else {
    _stopStatusPoll();
  }
}

/* ---------- View Log ---------- */

async function vmElbeStatus(name) {
  dashboardLogShow();
  const logEl = document.getElementById('dashboard-log-content');
  logEl.textContent = `$ elbe control --host localhost --port <port> status\n\nLoading…`;
  const d = await api(`/api/initvms/${name}/status`);
  let out = `$ ${d.command || 'elbe control status'}\n\n`;
  if (d.stdout) out += d.stdout + '\n';
  if (d.stderr) out += d.stderr + '\n';
  out += `\n→ exit code: ${d.returncode ?? '?'}`;
  logEl.textContent = out;
}

async function vmViewLog(name) {
  dashboardLogShow();
  const logEl = document.getElementById('dashboard-log-content');
  logEl.textContent = 'Loading log…';
  const d = await api(`/api/initvms/${name}/log?tail=200`);
  logEl.textContent = d.log || '(empty)';
  if (d.path) {
    logEl.textContent = `# ${d.path}\n\n` + logEl.textContent;
  }
  logEl.scrollTop = logEl.scrollHeight;
}

/* ---------- Create VM ---------- */

function vmShowCreate() {
  document.getElementById('vm-create-form').style.display = 'block';
  document.getElementById('vm-create-name').value = 'initvm';
  document.getElementById('vm-create-port').value = '';
}

async function vmCreate() {
  const name = document.getElementById('vm-create-name').value.trim();
  const portVal = document.getElementById('vm-create-port').value.trim();
  if (!name) { toast('VM name is required', 'error'); return; }
  if (!confirm(`Create VM '${name}'?\n\nThis takes 15–30 minutes.`)) return;

  document.getElementById('vm-create-form').style.display = 'none';
  dashboardLogShow();
  document.getElementById('dashboard-log-content').textContent = '';
  dashboardLogWrite(`▶ initvm create '${name}' (this will take a while…)\n\n`);

  const body = { name, skip_build_sources: true };
  if (portVal) body.soap_port = parseInt(portVal, 10);

  const d = await api('/api/initvms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (d.detail) {
    dashboardLogWrite(`✘ ${d.detail}\n`);
    toast('VM create blocked: ' + d.detail, 'error');
    vmLoad();
    return;
  }

  dashboardLogWrite(dashboardLogResult(d));
  if (d.returncode === 0) toast(`VM '${name}' created`, 'success');
  else toast(`VM '${name}' creation failed`, 'error');
  vmLoad();
}

/* ---------- Start / Stop / Delete ---------- */

async function vmStart(name) {
  toast(`Starting VM '${name}'…`, 'info', 4000);
  const d = await api(`/api/initvms/${name}/start`, { method: 'POST' });
  if (d.started) {
    toast(`VM '${name}' is starting — SOAP port ${d.soap_port}. Refreshing status…`, 'info', 6000);
    _startStatusPoll(10000, 30);
  } else {
    toast(d.detail || `Failed to start VM '${name}'`, 'error');
  }
  vmLoad();
}

async function vmStop(name) {
  if (!confirm(`Stop VM '${name}'?`)) return;
  toast(`Stopping VM '${name}'…`, 'info', 3000);
  dashboardLogShow();
  document.getElementById('dashboard-log-content').textContent = '';
  dashboardLogWrite(`▶ initvm stop '${name}'\n\n`);

  const d = await api(`/api/initvms/${name}/stop`, { method: 'POST' });
  dashboardLogWrite(dashboardLogResult(d));

  if (d.returncode === 0) toast(`VM '${name}' stopped`, 'success');
  else toast(`Failed to stop VM '${name}'`, 'error');
  vmLoad();
}

async function vmDelete(name) {
  if (!confirm(`Remove VM '${name}'?\n\nThis will permanently delete the VM directory.`)) return;
  const d = await api(`/api/initvms/${name}`, { method: 'DELETE' });
  if (d.deleted) toast(`VM '${name}' removed`, 'success');
  else toast(d.detail || 'Failed to remove VM', 'error');
  vmLoad();
}

/* ---------- Log panel ---------- */

function dashboardLogShow() {
  document.getElementById('dashboard-log').style.display = 'block';
}

function dashboardCloseLog() {
  document.getElementById('dashboard-log').style.display = 'none';
  document.getElementById('dashboard-log-content').textContent = '';
}

function dashboardLogWrite(text) {
  const el = document.getElementById('dashboard-log-content');
  el.textContent += text;
  el.scrollTop = el.scrollHeight;
}

function dashboardLogResult(d) {
  const cmd = d.command || '(unknown command)';
  const rc = d.returncode ?? '?';
  const ok = rc === 0;
  let log = `$ ${cmd}\n`;
  if (d.stdout) log += `${d.stdout}\n`;
  if (d.stderr) log += `${d.stderr}\n`;
  log += `\n→ exit code: ${rc}  ${ok ? '✔ success' : '✘ failed'}\n`;
  return log;
}

/* ---------- Auto-refresh after action ---------- */

function _startStatusPoll(intervalMs, maxAttempts) {
  _stopStatusPoll();
  let attempts = 0;
  _statusPollTimer = setInterval(async () => {
    attempts++;
    await vmLoad();
    if (attempts >= maxAttempts) _stopStatusPoll();
  }, intervalMs);
}

function _stopStatusPoll() {
  if (_statusPollTimer) { clearInterval(_statusPollTimer); _statusPollTimer = null; }
}

// Auto-refresh on load
document.addEventListener('DOMContentLoaded', vmLoad);
