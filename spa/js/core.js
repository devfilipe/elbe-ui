/* ==========================================================================
   ELBE UI – Core helpers: API calls, navigation, toasts
   ========================================================================== */

const API = window.location.origin;

// ---------- API helper ----------
async function api(path, opts) {
  try {
    const res = await fetch(API + path, opts);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Output box ----------
function show(id, data) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// ---------- Toast notifications ----------
function toast(msg, type = 'info', duration = 3500) {
  let c = document.getElementById('toast-container');
  if (!c) { c = document.createElement('div'); c.id = 'toast-container'; c.className = 'toast-container'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.remove(); }, duration);
}

// ---------- Navigation ----------
function navigateTo(page) {
  document.querySelectorAll('.sidebar button[data-page]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector(`.sidebar button[data-page="${page}"]`);
  if (btn) btn.classList.add('active');
  const el = document.getElementById(page);
  if (el) el.classList.add('active');
  // Auto-load data when switching pages
  if (page === 'projects') loadProjects();
  if (page === 'builds') { buildsLoadJobs(); buildsLoadOutputs(); }
  if (page === 'xml') loadXmlPage();
  if (page === 'sources') loadSources();
  if (page === 'packages') loadPackages();
  if (page === 'settings') loadSettings();
  if (page === 'apt-repo') loadAptRepo();
  if (page === 'maintainer') maintainerLoad();
  if (page === 'simulators') simLoad();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sidebar button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
});
