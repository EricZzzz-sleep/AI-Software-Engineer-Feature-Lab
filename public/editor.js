/* global document, window, sessionStorage, fetch, Option */
const $ = id => document.getElementById(id);
const fields = ['goal', 'facts', 'tone', 'draft'];
let token = sessionStorage.getItem('lab-token') || '';
let actorId = sessionStorage.getItem('lab-actor') || '';
let current = null;
let busy = false;
let expired = false;
let actorOptions = [];
const values = () => Object.fromEntries(fields.map(key => [key, $(key).value]));
const dirty = () => current && fields.some(key => $(key).value !== current[key]);
function announce(message) { $('status').textContent = message; }
function controls() {
  const changed = dirty();
  const editable = current && current.role !== 'viewer';
  const publisher = current?.role === 'publisher';
  fields.forEach(key => { $(key).readOnly = !editable || busy; });
  $('save').disabled = !editable || !changed || busy || expired;
  $('generate-reason').textContent = changed ? 'Save your changes before generating' : 'Generation is not configured';
  $('review').disabled = !publisher || !!changed || busy || expired;
  $('publish').disabled = !publisher || !!changed || busy || expired || !current?.reviewed;
  $('workflow-reason').textContent = !publisher ? 'Only a publisher can review and publish.' : expired ? 'Sign in again to continue.' : busy ? 'Wait for saving to finish.' : changed ? 'Save your changes before review or publish.' : !current?.reviewed ? 'Review this saved version before publishing.' : 'This saved version is reviewed and ready to publish.';
  $('saved').textContent = busy ? 'Working…' : changed ? `Unsaved · v${current?.version}` : `Saved v${current?.version}`;
  $('draft-status').textContent = editable ? 'Editable text · saved with the brief' : 'Read only';
  $('actor').disabled = busy;
  $('campaign').disabled = busy;
  $('signin').disabled = busy;
  $('reload').disabled = busy;
  document.querySelectorAll('#publication-list button').forEach(button => { button.disabled = busy; });
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { expired = true; $('signin').textContent = 'Sign in again'; controls(); }
    throw new Error(result.error || 'Request failed. Your text has been kept.');
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
  current = data;
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
  try { render(await api(`/api/campaigns/${current.id}`, 'PUT', { expectedVersion: current.version, ...values() })); announce(`Saved version ${current.version}.`); }
  catch (error) { announce(`Save failed. ${errorMessage(error)}`); }
  finally { busy = false; controls(); }
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
      actorOptions.forEach(actor => $('actor').append(new Option(`${actor.name} / ${actor.role} · Workspace ${actor.workspaceId.toUpperCase()}`, actor.id)));
      $('actor').value = actorId;
    }
    if (token) await loadSession();
    else $('notice').textContent = actorOptions.length ? 'Choose a test actor to open the editing space.' : 'A provisioned session is required. Production sign-in is not configured.';
  } catch (error) { $('notice').textContent = errorMessage(error); }
}
initialize();
