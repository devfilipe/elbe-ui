/* ==========================================================================
   ELBE UI – Simulators view (QEMU instances)
   ========================================================================== */

let _simConsoleInterval = null;

/* ---------- List simulators ---------- */

async function simLoad() {
  const d = await api('/api/simulators');
  const el = document.getElementById('sim-list');
  if (!el) return;

  const sims = d.simulators || [];
  if (!sims.length) {
    el.innerHTML = '<p style="color:var(--text-dim)">No simulators configured. Click "+ New Simulator" to create one.</p>';
    return;
  }

  let html = '<table><thead><tr>' +
    '<th>Name</th><th>Image</th><th>Memory</th><th>Status</th><th>Actions</th>' +
    '</tr></thead><tbody>';

  sims.forEach(s => {
    const running = s.runtime_status === 'running';
    const pidInfo = running && s.pid ? ` <span style="font-size:.72rem;color:var(--text-dim)">(PID ${s.pid})</span>` : '';
    const orphanNote = s.orphan ? ' <span style="font-size:.72rem;color:var(--yellow)" title="Detected as an orphan process (server was restarted). Console output is unavailable but you can stop it.">⚠ orphan</span>' : '';
    const badge = running
      ? `<span class="badge ok">running</span>${pidInfo}${orphanNote}`
      : '<span class="badge dim">stopped</span>';

    const imgName = s.image_path ? s.image_path.split('/').pop() : '<em>none</em>';

    let actions = '';
    if (running) {
      actions += `<button class="btn" onclick="simShowConsole('${s.id}','${s.name}')">Console</button> `;
      actions += `<button class="btn danger" onclick="simStop('${s.id}')">⏹ Stop</button> `;
      actions += `<button class="btn danger" onclick="simForceKill('${s.id}')" title="Force kill (SIGKILL) — use if Stop doesn't work" style="font-size:.72rem;padding:2px 6px">💀 Kill</button>`;
    } else {
      actions += `<button class="btn" onclick="simStart('${s.id}')">▶ Start</button> `;
      actions += `<button class="btn secondary" onclick="simEdit('${s.id}')">Edit</button> `;
      actions += `<button class="btn danger" onclick="simDelete('${s.id}')">✕</button>`;
    }

    html += `<tr>
      <td style="font-weight:600">${s.name}</td>
      <td style="font-family:monospace;font-size:.78rem">${imgName}</td>
      <td>${s.memory} MB</td>
      <td>${badge}</td>
      <td class="btn-row" style="border:0">${actions}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

/* ---------- Create / Edit ---------- */

function simShowCreate() {
  document.getElementById('sim-form').style.display = 'block';
  document.getElementById('sim-form-title').textContent = 'New Simulator';
  document.getElementById('sim-form-id').value = '';
  document.getElementById('sim-name').value = '';
  document.getElementById('sim-qemu-bin').value = '';
  document.getElementById('sim-memory').value = '1024';
  document.getElementById('sim-vnc').value = '';
  document.getElementById('sim-extra-args').value = '';
  document.getElementById('sim-serial').checked = true;
  simLoadImages();
}

async function simEdit(simId) {
  const d = await api('/api/simulators');
  const sim = (d.simulators || []).find(s => s.id === simId);
  if (!sim) { toast('Simulator not found', 'error'); return; }

  document.getElementById('sim-form').style.display = 'block';
  document.getElementById('sim-form-title').textContent = `Edit: ${sim.name}`;
  document.getElementById('sim-form-id').value = sim.id;
  document.getElementById('sim-name').value = sim.name || '';
  document.getElementById('sim-qemu-bin').value = sim.qemu_bin || '';
  document.getElementById('sim-memory').value = sim.memory || '1024';
  document.getElementById('sim-vnc').value = sim.vnc_display || '';
  document.getElementById('sim-extra-args').value = sim.extra_args || '';
  document.getElementById('sim-serial').checked = sim.serial_console !== false;

  await simLoadImages();
  // Select the current image
  const sel = document.getElementById('sim-image');
  if (sim.image_path) {
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === sim.image_path) { sel.selectedIndex = i; break; }
    }
  }
}

async function simLoadImages() {
  const d = await api('/api/simulators/images');
  const sel = document.getElementById('sim-image');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- select an image --</option>';
  const imgs = d.images || [];
  if (!imgs.length) {
    sel.innerHTML = '<option value="">⚠ No images found — check builds_dir in Settings</option>';
    return;
  }
  imgs.forEach(img => {
    const sizeMB = (img.size / 1048576).toFixed(1);
    const tag = img.needs_extract ? ' 📦 needs extract' : '';
    sel.innerHTML += `<option value="${img.path}" data-needs-extract="${img.needs_extract || false}" data-build="${img.build}">${img.name} (${img.build}, ${sizeMB} MB)${tag}</option>`;
  });
}

async function simSave() {
  const simId = document.getElementById('sim-form-id').value;
  let imagePath = document.getElementById('sim-image').value;
  const selectedOpt = document.getElementById('sim-image').selectedOptions[0];

  // If the image needs extraction, extract first
  if (selectedOpt && selectedOpt.dataset.needsExtract === 'true' && imagePath) {
    const buildDir = imagePath.substring(0, imagePath.lastIndexOf('/'));
    const filename = imagePath.substring(imagePath.lastIndexOf('/') + 1);
    toast('Extracting disk image — this may take a minute…', 'info', 10000);
    const ext = await api('/api/builds/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ build_path: buildDir, filename }),
    });
    if (ext.extracted) {
      imagePath = ext.extracted;
      toast(`Extracted: ${ext.extracted.split('/').pop()} (${(ext.size/1048576).toFixed(1)} MB)`, 'success');
    } else {
      toast(ext.error || 'Extraction failed', 'error');
      return;
    }
  }

  const body = {
    name: document.getElementById('sim-name').value,
    qemu_bin: document.getElementById('sim-qemu-bin').value,
    memory: document.getElementById('sim-memory').value,
    image_path: imagePath,
    extra_args: document.getElementById('sim-extra-args').value,
    serial_console: document.getElementById('sim-serial').checked,
    vnc_display: document.getElementById('sim-vnc').value,
  };

  if (!body.name) { toast('Name is required', 'error'); return; }

  let d;
  if (simId) {
    d = await api(`/api/simulators/${simId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    d = await api('/api/simulators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (d.id) {
    toast(`Simulator ${simId ? 'updated' : 'created'}: ${d.name}`, 'success');
    document.getElementById('sim-form').style.display = 'none';
    simLoad();
  } else {
    toast(d.detail || d.error || 'Failed', 'error');
  }
}

/* ---------- Start / Stop ---------- */

async function simStart(simId) {
  toast('Starting simulator…', 'info', 3000);
  const d = await api(`/api/simulators/${simId}/start`, { method: 'POST' });
  if (d.started) {
    toast(`Simulator started (PID: ${d.pid})`, 'success');
    simLoad();
    setTimeout(() => simShowConsole(simId, ''), 1000);
  } else if (d.orphan_detected) {
    toast(`Existing QEMU process detected (PID ${d.pid}) — recovering session`, 'info', 5000);
    simLoad();
  } else {
    toast(d.reason || d.detail || 'Failed to start', 'error');
    simLoad();
  }
}

async function simStop(simId) {
  if (!confirm('Stop this simulator?')) return;
  const d = await api(`/api/simulators/${simId}/stop`, { method: 'POST' });
  if (d.stopped) {
    toast(`Simulator stopped${d.killed_pid ? ' (PID ' + d.killed_pid + ')' : ''}`, 'success');
  } else {
    toast(d.reason || 'Failed to stop — try Force Kill', 'error');
  }
  simLoad();
}

async function simForceKill(simId) {
  if (!confirm('Force-kill this QEMU process (SIGKILL)?\n\nUse this if the normal Stop button did not work.')) return;
  const d = await api(`/api/simulators/${simId}/force-kill`, { method: 'POST' });
  if (d.killed) {
    toast(`Process killed${d.pid ? ' (PID ' + d.pid + ')' : ''}`, 'success');
  } else {
    toast(d.reason || 'Force-kill failed', 'error');
  }
  simLoad();
}

async function simDelete(simId) {
  if (!confirm('Delete this simulator configuration?')) return;
  const d = await api(`/api/simulators/${simId}`, { method: 'DELETE' });
  if (d.deleted) toast('Simulator deleted', 'success');
  simLoad();
}

/* ---------- Console ---------- */

function simShowConsole(simId, name) {
  document.getElementById('sim-console').style.display = 'block';
  document.getElementById('sim-console-title').textContent = name || simId;
  document.getElementById('sim-console-id').value = simId;
  document.getElementById('sim-console-output').textContent = 'Loading console output…';
  document.getElementById('sim-console-input').value = '';
  simRefreshConsole();

  // Auto-refresh every 1.5 seconds
  simStopAutoConsole();
  _simConsoleInterval = setInterval(() => simRefreshConsole(), 1500);
}

async function simRefreshConsole() {
  const simId = document.getElementById('sim-console-id').value;
  if (!simId) return;
  const d = await api(`/api/simulators/${simId}/output?tail=500`);
  const pre = document.getElementById('sim-console-output');
  // Strip ANSI escape sequences for cleaner display, but keep newlines
  let text = d.output || '(no output yet)';
  text = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');   // CSI sequences
  text = text.replace(/\x1b\][^\x07]*\x07/g, '');        // OSC sequences
  text = text.replace(/\x1b[()][0-9A-Z]/g, '');          // charset switches
  text = text.replace(/[\x00-\x08\x0e-\x1f]/g, '');      // other control chars (keep \t \n \r)
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  pre.textContent = text;
  pre.scrollTop = pre.scrollHeight;
  if (!d.running) {
    simStopAutoConsole();
    pre.textContent += '\n\n--- Simulator has stopped ---';
    simLoad();
  }
}

async function simSendInput() {
  const simId = document.getElementById('sim-console-id').value;
  const input = document.getElementById('sim-console-input');
  const text = input.value;
  if (!simId || !text && text !== '') return;
  await api(`/api/simulators/${simId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text + '\n' }),
  });
  input.value = '';
  input.focus();
  setTimeout(simRefreshConsole, 500);
}

/** Send a raw key sequence (no appended newline). Useful for GRUB / special keys. */
async function simSendKey(key) {
  const simId = document.getElementById('sim-console-id').value;
  if (!simId) return;
  await api(`/api/simulators/${simId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: key }),
  });
  setTimeout(simRefreshConsole, 300);
}

function simStopAutoConsole() {
  if (_simConsoleInterval) {
    clearInterval(_simConsoleInterval);
    _simConsoleInterval = null;
  }
}

/* ---------- Quick-create from builds page ---------- */

function simCreateFromImage(imagePath, imageName, buildName) {
  navigateTo('simulators');
  setTimeout(async () => {
    simShowCreate();
    // Use build name as simulator name (e.g. x86_64-qemu-hdimg-06f0327e)
    document.getElementById('sim-name').value = buildName || imageName.replace(/\.(img|qcow2)$/, '');

    // Load images from backend so the dropdown is populated
    await simLoadImages();

    const sel = document.getElementById('sim-image');
    let found = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === imagePath) {
        sel.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found) {
      // Image not in the list (shouldn't happen, but fallback)
      const opt = document.createElement('option');
      opt.value = imagePath;
      opt.textContent = imageName;
      sel.appendChild(opt);
      sel.value = imagePath;
    }
  }, 300);
}
