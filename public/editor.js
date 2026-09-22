/* global document, window, sessionStorage, localStorage, fetch, Option, crypto, setInterval */
const $ = id => document.getElementById(id);
const fields = ['goal', 'facts', 'tone', 'draft'];
let token = sessionStorage.getItem('lab-token') || '';
let actorId = sessionStorage.getItem('lab-actor') || '';
let current = null;
let busy = false;
let expired = false;
let generating = false;
let generationJob = null;
let checkingGeneration = false;
let actorOptions = [];
let selectedVersion = null;
const values = () => Object.fromEntries(fields.map(key => [key, $(key).value]));
const dirty = () => current && fields.some(key => $(key).value !== current[key]);
function announce(message) { $('status').textContent = message; }
function controls() {
  const changed = dirty();
  const editable = current && current.role !== 'viewer';
  const publisher = current?.role === 'publisher';
  $('editor-tabs').hidden = !publisher;
  for (const id of ['edit-tab', 'versions-tab', 'version-select']) $(id).disabled = busy || generating;
  $('review-version').disabled = !publisher || busy || generating || expired || !selectedVersion || selectedVersion.reviewed;
  fields.forEach(key => { $(key).readOnly = !editable || busy; });
  if ($('fail-save')) $('fail-save').disabled = !editable || busy || generating || expired;
  if ($('reset-v7')) $('reset-v7').disabled = busy || generating;
  $('save').disabled = !editable || busy || expired;
  const briefDirty = current && ['goal', 'facts', 'tone'].some(key => $(key).value !== current[key]);
  const pending = current && readPending(generationScope());
  $('generate').disabled = !editable || busy || generating || expired || !current?.generationEnabled || (!pending && (!current.goal.trim() || briefDirty || isActiveJob(generationJob)));
  $('scenario').disabled = !editable || busy || generating || expired;
  $('release-job').disabled = !editable || busy || !isActiveJob(generationJob);
  $('generate').textContent = generating ? 'Submitting…' : generationJob?.status === 'failed' ? 'Retry generation' : generationJob?.status === 'obsolete' ? 'Regenerate' : 'Generate';
  $('generate-reason').textContent = !editable ? 'Only editors and publishers can generate.' : !current?.generationEnabled ? 'Generation is not configured' : briefDirty ? 'Save your brief changes before generating.' : !current.goal.trim() ? 'Save a goal and audience before generating.' : isActiveJob(generationJob) ? 'Generation is running. You can leave and return to this job.' : 'Generate from the saved brief. Successful output is saved automatically.';
  $('review').disabled = !publisher || !!changed || busy || generating || expired;
  $('publish').disabled = !publisher || !!changed || busy || generating || expired || !current?.reviewed;
  $('workflow-reason').textContent = !publisher ? 'Only a publisher can review and publish.' : expired ? 'Sign in again to continue.' : busy ? 'Wait for the current action to finish.' : changed ? 'Save your changes before review or publish.' : !current?.reviewed ? 'Review this saved version before publishing.' : 'This saved version is reviewed and ready to publish.';
  $('saved').textContent = busy ? 'Working…' : changed ? `Unsaved · v${current?.version}` : `Saved v${current?.version}`;
  $('draft-status').textContent = `${editable ? 'Editable text · saved with the brief' : 'Read only'}${current?.draft_revision > 0 && current.draft_brief_revision < current.brief_revision ? ' · Out of date' : ''}`;
  $('actor').disabled = busy || generating;
  $('campaign').disabled = busy || generating;
  $('signin').disabled = busy || generating;
  $('reload').disabled = busy || generating;
  document.querySelectorAll('#publication-list button').forEach(button => { button.disabled = busy || generating; });
}
async function api(path, method = 'GET', data) {
  let response, result;
  try {
    response = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    result = await response.json();
  } catch (error) {
    if (method === 'PUT') throw new Error('Save outcome unknown; the request may have succeeded. Your input has been kept. Reload saved content to confirm.');
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401) { expired = true; $('signin').textContent = 'Sign in again'; controls(); }
    const error = new Error(result.error || 'Request failed. Your text has been kept.');
    error.status = response.status; error.activeJobId = result.activeJobId;
    throw error;
  }
  return result;
}
function errorMessage(error) { return error.message === 'Failed to fetch' ? 'Connection failed. Your text has been kept. Try again.' : error.message; }
function showDialog(title, description, content = '', confirmLabel = 'Confirm') {
  const dialog = $('dialog');
  const origin = document.activeElement;
  $('dialog-title').textContent = title;
  $('dialog-description').textContent = description;
  $('dialog-content').textContent = content;
  $('dialog-confirm').textContent = confirmLabel;
  dialog.showModal();
  $('dialog-cancel').focus();
  return new Promise(resolve => {
    const finish = accepted => {
      dialog.close();
      $('dialog-confirm').onclick = null;
      $('dialog-cancel').onclick = null;
      dialog.oncancel = null;
      origin?.focus();
      resolve(accepted);
    };
    $('dialog-confirm').onclick = () => finish(true);
    $('dialog-cancel').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
  });
}
async function discardAllowed() {
  return !dirty() || await showDialog('Discard unsaved changes?', 'Your local brief and draft edits have not been saved. Continue only if you want to discard them.', '', 'Discard changes');
}
function render(data) {
  if (current?.id !== data.id) {
    generationJob = null;
    $('generation-status').textContent = 'Loading generation status…';
    $('job-id').textContent = '';
  }
  current = data;
  selectedVersion = null;
  showEditorTab(false);
  fields.forEach(key => { $(key).value = data[key]; });
  $('title').textContent = `Campaign / ${data.title}`;
  $('editor').hidden = false;
  $('publication-list').replaceChildren();
  $('publications').hidden = data.publications.length === 0;
  for (const publication of data.publications) {
    const button = document.createElement('button');
    button.textContent = `View published v${publication.version}`;
    button.onclick = async () => {
      busy = true; controls();
      try {
        const result = await api(`/api/campaigns/${current.id}/publications/${publication.id}`);
        const snapshot = JSON.parse(result.snapshot);
        await showDialog(`Published v${publication.version}`, 'This is an immutable, read-only snapshot.', preview(snapshot), 'Close');
      } catch (error) { announce(errorMessage(error)); }
      finally { busy = false; controls(); button.focus(); }
    };
    $('publication-list').append(button);
  }
  controls();
}
function preview(data) { return `Goal + audience\n${data.goal}\n\nSource facts\n${data.facts}\n\nTone\n${data.tone}\n\nDraft\n${data.draft}`; }
async function loadCampaign(id) {
  const wasBusy = busy;
  busy = true; controls();
  try {
    const data = await api(`/api/campaigns/${id}`);
    render(data);
    announce(`Saved version ${data.version} loaded.`);
    await refreshGeneration();
  } finally { busy = wasBusy; controls(); }
}
async function loadSession() {
  const me = await api('/api/me');
  $('identity').textContent = `${me.name} · ${me.memberships.map(m => `${m.role} · Workspace ${m.workspace_id.toUpperCase()}`).join(', ')}`;
  const campaigns = await api('/api/campaigns');
  $('campaign').replaceChildren(...campaigns.map(c => new Option(c.title, c.id)));
  $('picker').hidden = campaigns.length < 2;
  if (campaigns.length) await loadCampaign(campaigns[0].id);
  else { current = null; $('editor').hidden = true; }
  $('notice').textContent = campaigns.length ? 'Your campaign workspace' : 'No campaigns are available in this workspace.';
}
async function signIn(nextActor) {
  if (!nextActor) return;
  const sameActor = actorId === nextActor;
  if (!sameActor && !await discardAllowed()) { $('actor').value = actorId; return; }
  busy = true; controls();
  try {
    const session = await api('/__test/session', 'POST', { actorId: nextActor });
    token = session.token;
    actorId = nextActor;
    sessionStorage.setItem('lab-token', token);
    sessionStorage.setItem('lab-actor', actorId);
    expired = false;
    $('signin').textContent = 'Sign in again';
    if (sameActor && current) { announce('Signed in again. Your local text has been kept.'); controls(); }
    else { current = null; $('editor').hidden = true; await loadSession(); }
  } catch (error) { $('notice').textContent = errorMessage(error); $('actor').value = actorId; }
  finally { busy = false; controls(); }
}
$('signin').onclick = () => signIn($('actor').value);
$('actor').onchange = () => signIn($('actor').value);
$('campaign').onchange = async () => {
  const id = $('campaign').value;
  if (!await discardAllowed()) { $('campaign').value = current.id; return; }
  try { await loadCampaign(id); } catch (error) { announce(errorMessage(error)); $('campaign').value = current.id; }
};
fields.forEach(key => $(key).addEventListener('input', () => { controls(); announce(dirty() ? 'Unsaved changes' : `Saved version ${current.version}`); }));
$('save').onclick = async () => {
  busy = true; controls(); announce('Saving brief and draft…');
  try {
    const submitted = values();
    const saved = await api(`/api/campaigns/${current.id}`, 'PUT', { expectedVersion: current.version, ...submitted });
    const local = values();
    render(saved);
    // A generation response may arrive while this save is in flight.
    fields.forEach(key => { if (local[key] !== submitted[key]) $(key).value = local[key]; });
    announce(`Saved version ${current.version}.${dirty() ? ' New generated draft is still unsaved.' : ''}`);
  }
  catch (error) {
    announce(error.message.startsWith('Save outcome unknown') ? error.message : `Save failed. ${errorMessage(error)}`);
    if ($('mentor-status') && error.message.includes('Injected failure before commit')) $('mentor-status').textContent = 'The injected failure was consumed. Retry Save to persist your input.';
  }
  finally { busy = false; controls(); }
};
$('generate').onclick = async () => {
  if ($('generate').disabled) return;
  generating = true; controls();
  const scope = generationScope();
  const id = current.id;
  const session = token;
  try {
    let pending = readPending(scope);
    if (!pending) {
      pending = { key: crypto.randomUUID(), briefRevision: current.brief_revision, draftRevision: current.draft_revision };
      localStorage.setItem(scope, JSON.stringify(pending));
    }
    const result = await api(`/api/campaigns/${id}/generate`, 'POST', pending);
    localStorage.removeItem(scope);
    if (current?.id === id && token === session) {
      generationJob = result;
      displayGeneration();
    }
  } catch (error) {
    if (error.status && error.status < 500) localStorage.removeItem(scope);
    if (current?.id === id && token === session) {
      $('generation-status').textContent = error.status ? errorMessage(error) : 'Submission outcome unknown. Retry Generate to reuse the same request key.';
      if (error.activeJobId) await refreshGeneration();
    }
  } finally { generating = false; controls(); }
};
$('reload').onclick = async () => {
  if (!await discardAllowed()) return;
  try { await loadCampaign(current.id); } catch (error) { announce(errorMessage(error)); }
};
for (const action of ['review', 'publish']) {
  $(action).onclick = async () => {
    const saved = current;
    const accepted = await showDialog(action === 'review' ? `Review saved v${saved.version}` : `Publish saved v${saved.version}?`, action === 'review' ? 'Review the saved brief and draft, then confirm approval.' : 'Publish this reviewed version as an immutable snapshot.', preview(saved), action === 'review' ? 'Confirm review' : 'Publish');
    if (!accepted) return;
    busy = true; controls();
    try {
      const result = await api(`/api/campaigns/${saved.id}/${action}`, 'POST', { expectedVersion: saved.version });
      // Only metadata changes here; never replace local text with an unsolicited server update.
      if (action === 'review') current.reviewed = result.reviewed;
      else current.publications = [{ id: result.id, version: result.version, published_at: result.published_at }, ...current.publications.filter(p => p.id !== result.id)];
      render(current);
      announce(action === 'review' ? `Version ${saved.version} reviewed.` : `Version ${saved.version} published.`);
    } catch (error) { announce(errorMessage(error)); }
    finally { busy = false; controls(); $(action).focus(); }
  };
}
window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
async function initialize() {
  try {
    const response = await fetch('/__test/actors');
    if (response.ok) {
      actorOptions = await response.json();
      $('session-bar').hidden = false;
      if ($('mentor-drills')) $('mentor-drills').hidden = false;
      $('fake-generation').hidden = false;
      actorOptions.forEach(actor => $('actor').append(new Option(`${actor.name} / ${actor.role} · Workspace ${actor.workspaceId.toUpperCase()}`, actor.id)));
      $('actor').value = actorId;
    }
    if (token) await loadSession();
    else $('notice').textContent = actorOptions.length ? 'Choose a test actor to open the editing space.' : 'A provisioned session is required. Production sign-in is not configured.';
  } catch (error) { $('notice').textContent = errorMessage(error); }
}
initialize();

function showEditorTab(history) {
  $('edit-panel').hidden = history;
  $('versions-panel').hidden = !history;
  $('edit-tab').setAttribute('aria-selected', String(!history));
  $('versions-tab').setAttribute('aria-selected', String(history));
  $('edit-tab').tabIndex = history ? -1 : 0;
  $('versions-tab').tabIndex = history ? 0 : -1;
}
function renderVersion(data) {
  selectedVersion = data;
  $('version-preview').textContent = preview(data);
  $('version-meta').textContent = `Version ${data.version} · Saved by ${data.author} · ${data.saved_at} · ${data.reviewed ? 'Reviewed' : 'Not reviewed'}`;
}
async function loadSelectedVersion() {
  selectedVersion = null;
  $('version-preview').textContent = '';
  $('version-meta').textContent = '';
  const data = await api(`/api/campaigns/${current.id}/versions/${$('version-select').value}`);
  renderVersion(data);
}
$('edit-tab').onclick = () => showEditorTab(false);
$('versions-tab').onclick = async () => {
  if (busy || current?.role !== 'publisher') return;
  showEditorTab(true);
  selectedVersion = null;
  $('version-preview').textContent = ''; $('version-meta').textContent = '';
  busy = true; controls(); $('versions-status').textContent = 'Loading saved versions…';
  try {
    const versions = await api(`/api/campaigns/${current.id}/versions`);
    $('version-select').replaceChildren(...versions.map(v => new Option(`Version ${v.version}${v.reviewed ? ' · Reviewed' : ''}`, v.version)));
    if (versions.length) await loadSelectedVersion();
    $('versions-status').textContent = versions.length ? 'Choose a saved version to inspect and review. Your editor input is kept.' : 'No saved versions are available.';
  } catch (error) { $('versions-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
$('version-select').onchange = async () => {
  busy = true; controls();
  try { await loadSelectedVersion(); $('versions-status').textContent = `Saved version ${selectedVersion.version} loaded.`; }
  catch (error) { $('versions-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
$('review-version').onclick = async () => {
  if ($('review-version').disabled) return;
  const saved = selectedVersion;
  const id = current.id;
  if (!await showDialog(`Review saved v${saved.version}`, 'Review this saved brief and draft, then confirm approval of this version only.', preview(saved), 'Confirm review')) return;
  busy = true; controls();
  try {
    const result = await api(`/api/campaigns/${id}/versions/${saved.version}/review`, 'POST', {});
    renderVersion(result);
    $('version-select').selectedOptions[0].textContent = `Version ${saved.version} · Reviewed`;
    if (current.version === saved.version) current.reviewed = true;
    $('versions-status').textContent = `Version ${saved.version} reviewed.`;
  } catch (error) { $('versions-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); $('version-select').focus(); }
};
for (const id of ['edit-tab', 'versions-tab']) $(id).onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 'edit-tab' : event.key === 'End' ? 'versions-tab' : id === 'edit-tab' ? 'versions-tab' : 'edit-tab';
  if (!$(target).disabled) { $(target).focus(); $(target).click(); }
};

function isActiveJob(job) { return job && ['queued', 'running', 'retrying'].includes(job.status); }
function generationScope() { return `generation:${actorId}:${current.workspace_id}:${current.id}`; }
function readPending(scope) {
  try { return JSON.parse(localStorage.getItem(scope) || 'null'); }
  catch { localStorage.removeItem(scope); return null; }
}
function displayGeneration() {
  const job = generationJob;
  $('job-id').textContent = job ? `Job ${job.id}` : '';
  const labels = { queued: 'Queued', running: 'Generating', retrying: 'Retrying', succeeded: 'Draft saved', failed: 'Generation failed', obsolete: 'Generation out of date' };
  $('generation-status').textContent = job ? `${labels[job.status]} · Attempt ${job.attempts}/2${job.error ? ` · ${job.error}` : ''}${job.status === 'obsolete' ? '. Your saved draft was preserved. Regenerate from the latest saved brief.' : job.status === 'failed' ? '. Your saved draft was preserved. You can retry with a new request.' : ''}` : 'No generation job yet.';
  if (job?.status === 'succeeded' && current.version < job.appliedVersion && dirty()) $('generation-status').textContent += ' A new draft revision was saved. Your local edits are kept; reload saved content when ready.';
  controls();
}
async function refreshGeneration() {
  if (!current || !token || expired || checkingGeneration || generating) return;
  const id = current.id, session = token;
  checkingGeneration = true;
  try {
    const status = await api(`/api/campaigns/${id}/generations`);
    if (current?.id !== id || token !== session) return;
    generationJob = status.active || status.latest;
    displayGeneration();
    if (readPending(generationScope())) $('generation-status').textContent += ' An unconfirmed submission is saved locally. Retry Generate to resolve it with the same key.';
    if (generationJob?.status === 'succeeded' && current.version < generationJob.appliedVersion && !dirty() && !busy && $('versions-panel').hidden && !$('dialog').open) {
      const saved = await api(`/api/campaigns/${id}`);
      if (current?.id === id && token === session && !dirty() && !busy && $('versions-panel').hidden && !$('dialog').open) { render(saved); displayGeneration(); }
    }
  } catch (error) {
    if (current?.id === id && token === session) $('generation-status').textContent = `Status unavailable. ${errorMessage(error)} Reconnecting automatically.`;
  } finally { checkingGeneration = false; }
}
$('scenario').onchange = async () => {
  busy = true; controls();
  try {
    await api('/__test/generation-scenario', 'POST', { campaignId: current.id, scenario: $('scenario').value });
    $('fake-status').textContent = 'Scenario saved for the next new job.';
  } catch (error) { $('fake-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
$('release-job').onclick = async () => {
  busy = true; controls();
  try {
    await api('/__test/generation-release', 'POST', { campaignId: current.id, jobId: generationJob.id });
    $('fake-status').textContent = 'Job released.';
  } catch (error) { $('fake-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
setInterval(() => { if (!busy && !document.hidden) refreshGeneration(); }, 1000);

if ($('fail-save')) $('fail-save').onclick = async () => {
  busy = true; controls();
  try {
    await api('/__test/save-failure', 'POST', { campaignId: current.id });
    $('mentor-status').textContent = 'Armed for this session and campaign: your next valid save will fail before commit. Invalid or conflicting saves do not consume it.';
  } catch (error) { $('mentor-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
if ($('reset-v7')) $('reset-v7').onclick = async () => {
  if (!await showDialog('Reset demo fixtures to v7?', 'This replaces all demo data, discards local edits in this tab, and revokes all sessions. Both tabs must sign in again and load v7 before the conflict drill.', '', 'Reset fixtures')) return;
  busy = true; controls();
  try {
    await api('/__test/fixtures', 'POST', { scenario: 'conflict-v7' });
    if (current) localStorage.removeItem(generationScope());
    generationJob = null;
    token = ''; actorId = ''; current = null; expired = false;
    sessionStorage.removeItem('lab-token'); sessionStorage.removeItem('lab-actor');
    fields.forEach(key => { $(key).value = ''; });
    $('editor').hidden = true; $('picker').hidden = true; $('actor').value = '';
    $('identity').textContent = ''; $('signin').textContent = 'Sign in';
    $('notice').textContent = 'Fixtures reset to v7. Sign in again in both tabs to begin the drill.';
    $('mentor-status').textContent = 'Reset complete. All armed failures and sessions were cleared.';
  } catch (error) { $('mentor-status').textContent = errorMessage(error); }
  finally { busy = false; controls(); }
};
