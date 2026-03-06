/* ==========================================================================
   ELBE UI – Submit Build view
   ========================================================================== */

async function loadSubmitXmlOptions() {
  const d = await api('/api/xml/list');
  const sel = document.getElementById('submit-xml-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- select an XML file --</option>';
  (d.files || []).forEach(f => {
    sel.innerHTML += `<option value="${f.path}">${f.name} (${f.dir})</option>`;
  });
}

async function submitBuild() {
  let xmlPath = document.getElementById('submit-xml-select').value;
  const fileInput = document.getElementById('submit-xml-file');

  // If a file was selected for upload, upload it first
  if (fileInput && fileInput.files.length) {
    const form = new FormData();
    form.append('file', fileInput.files[0]);
    const up = await fetch(API + '/api/upload_xml', { method: 'POST', body: form });
    const upData = await up.json();
    xmlPath = upData.path;
  }

  if (!xmlPath) { toast('Please select or upload an XML file', 'error'); return; }

  show('submit-output', 'Submitting build…');
  toast('Submitting build in background…', 'info', 3000);

  const d = await api('/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      xml_path: xmlPath,
      build_bin: document.getElementById('submit-bin').checked,
      build_sources: document.getElementById('submit-src').checked,
    }),
  });

  if (d.job_id) {
    let msg = `Build queued! Job ID: ${d.job_id}`;
    if (d.queued > 0) msg += ` (${d.queued} in queue, ${d.running}/${d.max} running)`;
    show('submit-output', msg + '\nSwitch to Local Builds to track progress.');
    toast(msg + ' – see Local Builds', 'success', 5000);
    // Auto-switch to builds page after 2 seconds
    setTimeout(() => {
      navigateTo('builds');
      buildsShowLog(d.job_id, '');
    }, 1500);
  } else {
    show('submit-output', d);
    toast('Failed to submit build', 'error');
  }
}
