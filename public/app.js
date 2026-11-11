const $ = selector => document.querySelector(selector);
const state = { view: 'overview', filter: 'all', library: null, request: 0, readerRequest: 0, uploading: false, selectedPath: '' };
const viewInfo = {
  overview: ['Room for your next idea.', 'A quiet place to collect, explore, and connect what you know.', 'Your library', "Everything you've collected, in one place."],
  sources: ['A home for your sources.', 'The original pieces. Preserved exactly as you brought them in.', 'Source library', 'Upload a document now. Connect the ideas when you are ready.'],
  wiki: ['Connect the dots.', 'Your source-grounded knowledge, one page at a time.', 'Wiki pages', 'Explore your index, concepts, entities, and saved answers.'],
  activity: ['The story of your wiki.', 'A record of what you have learned, connected, and maintained.', 'Activity log', 'Open the log to follow your wiki as it grows.'],
};

function node(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value, year = false) {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
}

function showError(message) {
  $('#error-banner').textContent = message;
  $('#error-banner').hidden = !message;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `The workspace returned an error (${response.status}).`);
  return body;
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

function visibleEntries() {
  if (!state.library) return [];
  return state.library.entries.filter(entry => {
    if (state.view === 'activity') return entry.path === 'wiki/log.md';
    if (state.view === 'sources') return entry.kind === 'source';
    if (state.view === 'wiki') return entry.kind === 'wiki' || entry.path === 'wiki/index.md';
    return entry.kind !== 'system' && (state.filter === 'all' || entry.kind === state.filter);
  });
}

function renderList() {
  const list = $('#library-list');
  if (!state.library) {
    list.replaceChildren(node('p', 'loading-message', 'Opening your workspace...'));
    $('#result-count').textContent = 'Loading';
    return;
  }
  const entries = visibleEntries();
  list.replaceChildren();
  $('#result-count').textContent = `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`;
  if (!entries.length) {
    const empty = node('div', 'empty-state');
    const searching = Boolean($('#search-input').value.trim());
    const art = node('div', 'empty-art', searching ? '?' : '+');
    art.setAttribute('aria-hidden', 'true');
    empty.append(art, node('h3', '', searching ? 'Nothing here just yet.' : 'Your next discovery starts here.'));
    empty.append(node('p', '', searching ? 'Try another phrase or a different view. Search looks inside text files, and at the names of PDFs and Office documents.' :
      state.filter === 'wiki' ? 'Ask your coding agent to ingest a source, then refresh to see the wiki pages it creates.' :
      'Add your first document and give your knowledge a place to grow.'));
    const action = node('button', 'text-button', searching ? 'Clear search' : 'Add your first document');
    action.type = 'button';
    action.addEventListener('click', () => {
      if (searching) { $('#search-input').value = ''; loadLibrary(); }
      else $('#file-input').click();
    });
    action.disabled = !state.library || state.uploading;
    if (state.filter !== 'wiki' || searching) empty.append(action);
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = node('button', 'document-row');
    row.type = 'button';
    const extension = entry.extension.slice(1).toUpperCase() || 'FILE';
    const icon = node('span', `file-icon ${entry.kind !== 'source' ? 'wiki' : extension === 'PDF' ? 'pdf' : ''}`, extension);
    icon.setAttribute('aria-hidden', 'true');
    const info = node('span', 'document-info');
    info.append(node('strong', '', entry.title));
    info.append(node('small', '', `${entry.category}  /  ${formatSize(entry.size)}${entry.name !== entry.title ? `  /  ${entry.name}` : ''}`));
    if (entry.snippet) info.append(node('span', 'snippet', entry.snippet));
    const date = node('span', 'row-date', formatDate(entry.modified));
    const arrow = node('span', 'row-arrow', '\u2197');
    arrow.setAttribute('aria-hidden', 'true');
    row.append(icon, info, date, arrow);
    row.addEventListener('click', () => openDocument(entry.path));
    list.append(row);
  }
}

function render() {
  const [title, description, libraryTitle, subtitle] = viewInfo[state.view];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('#library-title').textContent = libraryTitle;
  $('#library-subtitle').textContent = subtitle;
  $('#breadcrumb').textContent = state.view === 'sources' ? 'SOURCE LIBRARY' : state.view.toUpperCase();
  $('#stats').hidden = state.view !== 'overview';
  $('.filter-row').hidden = state.view !== 'overview';
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const button of document.querySelectorAll('[data-filter]')) {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (state.library) {
    $('#stat-sources').textContent = state.library.stats.sources;
    $('#stat-wiki').textContent = state.library.stats.pages;
    $('#source-count').textContent = state.library.stats.sources;
    $('#wiki-count').textContent = state.library.stats.pages;
    $('#stat-updated').textContent = state.library.stats.lastUpdated ? formatDate(state.library.stats.lastUpdated) : 'Not yet';
    $('#workspace-name').textContent = state.library.workspace;
  }
  renderList();
}

async function loadLibrary() {
  const request = ++state.request;
  $('#library-list').setAttribute('aria-busy', 'true');
  $('#refresh-button').disabled = true;
  try {
    const query = $('#search-input').value.trim();
    const library = await api(`/api/library?q=${encodeURIComponent(query)}`);
    if (request !== state.request) return;
    state.library = library;
    showError('');
    render();
  } catch (error) {
    if (request !== state.request) return;
    showError(`Could not load the workspace: ${error.message}`);
    if (!state.library) $('#library-list').replaceChildren(node('p', 'loading-message', 'The workspace is unavailable. Check that the local server is running, then press Refresh.'));
  } finally {
    if (request === state.request) {
      $('#library-list').setAttribute('aria-busy', 'false');
      $('#refresh-button').disabled = false;
      $('#upload-button').disabled = !state.library || state.uploading;
      $('#dropzone').disabled = !state.library || state.uploading;
      $('#open-index').disabled = !state.library;
    }
  }
}

function setView(view) {
  if (!viewInfo[view]) view = 'overview';
  state.view = view;
  state.filter = 'all';
  history.replaceState(null, '', `#${view}`);
  render();
}

function localLink(target, sourcePath, wiki = false) {
  const [reference, anchor = ''] = target.split('#', 2);
  if (wiki) {
    const normalized = reference.replace(/\.md$/i, '').toLowerCase();
    const matches = state.library.links.filter(entry => {
      const full = entry.path.replace(/\.md$/i, '').toLowerCase();
      return full === normalized || full.split('/').at(-1) === normalized;
    });
    return matches.length === 1 ? { path: matches[0].path, anchor } : null;
  }
  try {
    const url = new URL(target, `${location.origin}/${sourcePath}`);
    if (url.origin !== location.origin) return null;
    const relative = decodeURIComponent(url.pathname.slice(1));
    return state.library.links.some(entry => entry.path === relative) ? { path: relative, anchor: url.hash.slice(1) } : null;
  } catch {
    return null;
  }
}

function inlineMarkdown(parent, text, sourcePath) {
  const tokens = /`([^`]+)`|\[\[([^\]\n]+)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let position = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    if (match[1]) parent.append(node('code', '', match[1]));
    else if (match[5] || match[6]) parent.append(node(match[5] ? 'strong' : 'em', '', match[5] || match[6]));
    else {
      const isWiki = Boolean(match[2]);
      const [reference, alias] = isWiki ? match[2].split('|', 2) : [match[4], match[3]];
      const label = alias || reference;
      const local = localLink(reference, sourcePath, isWiki);
      if (local) {
        const link = node('a', 'wiki-link', label);
        link.href = '#';
        link.addEventListener('click', event => { event.preventDefault(); openDocument(local.path, local.anchor); });
        parent.append(link);
      } else if (!isWiki && /^https?:\/\//i.test(reference)) {
        const link = node('a', '', label);
        link.href = reference;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      } else {
        const unresolved = node('span', 'broken-link', label);
        unresolved.title = 'This link is missing, ambiguous, or not supported by the local reader.';
        parent.append(unresolved);
      }
    }
    position = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

function headingId(text) {
  return `doc-${text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')}`;
}

function renderMarkdown(content, documentInfo) {
  const fragment = document.createDocumentFragment();
  let paragraph = [];
  let code = null;
  let list = null;
  function flush() {
    if (paragraph.length) {
      const p = node('p');
      inlineMarkdown(p, paragraph.join('\n'), documentInfo.path);
      fragment.append(p);
      paragraph = [];
    }
    list = null;
  }
  for (const [index, line] of content.replace(/\r\n/g, '\n').split('\n').entries()) {
    if (/^\s*```/.test(line)) {
      flush();
      if (code !== null) {
        const pre = node('pre');
        pre.append(node('code', '', code.join('\n')));
        fragment.append(pre);
        code = null;
      } else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (heading) {
      flush();
      if (index === 0 && heading[1] === '#' && heading[2].trim() === documentInfo.title) continue;
      const h = node(`h${heading[1].length}`);
      h.id = headingId(heading[2]);
      inlineMarkdown(h, heading[2], documentInfo.path);
      fragment.append(h);
    } else if (item) {
      if (paragraph.length) flush();
      const type = item[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== type) {
        list = node(type);
        fragment.append(list);
      }
      const li = node('li');
      inlineMarkdown(li, item[2], documentInfo.path);
      list.append(li);
    } else if (/^>\s?/.test(line)) {
      flush();
      const quote = node('blockquote');
      inlineMarkdown(quote, line.replace(/^>\s?/, ''), documentInfo.path);
      fragment.append(quote);
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      fragment.append(node('hr'));
    } else if (!line.trim()) flush();
    else { list = null; paragraph.push(line); }
  }
  flush();
  if (code !== null) {
    const pre = node('pre');
    pre.append(node('code', '', code.join('\n')));
    fragment.append(pre);
  }
  return fragment;
}

async function openDocument(relative, anchor = '') {
  const request = ++state.readerRequest;
  state.selectedPath = relative;
  $('#reader-title').textContent = state.library?.links.find(entry => entry.path === relative)?.title || relative.split('/').at(-1);
  $('#reader-meta').textContent = relative.replaceAll('/', '\\');
  $('#reader-category').textContent = 'OPENING DOCUMENT';
  $('#reader-notice').hidden = true;
  $('#download-link').href = `/api/download?path=${encodeURIComponent(relative)}`;
  $('#reader-content').replaceChildren(node('p', '', 'Opening your document...'));
  if (!$('#reader').open) $('#reader').showModal();
  try {
    const documentInfo = await api(`/api/document?path=${encodeURIComponent(relative)}`);
    if (request !== state.readerRequest) return;
    $('#reader-title').textContent = documentInfo.title;
    $('#reader-category').textContent = documentInfo.category.toUpperCase();
    $('#reader-meta').textContent = `${relative.replaceAll('/', '\\')}  /  ${formatSize(documentInfo.size)}  /  Updated ${formatDate(documentInfo.modified, true)}`;
    if (!documentInfo.previewable) {
      const placeholder = node('div', 'empty-state');
      placeholder.append(node('div', 'empty-art', documentInfo.extension.slice(1).toUpperCase()),
        node('h3', '', 'Your original, safely stored.'),
        node('p', '', 'This format does not have a browser text preview. Download it to read in its usual application. It has not been converted or ingested into the wiki.'));
      $('#reader-content').replaceChildren(placeholder);
    } else if (['.md', '.markdown'].includes(documentInfo.extension)) {
      $('#reader-content').replaceChildren(renderMarkdown(documentInfo.content, documentInfo));
    } else {
      $('#reader-content').replaceChildren(node('pre', 'raw-text', documentInfo.content));
    }
    if (documentInfo.truncated) {
      $('#reader-notice').textContent = 'Showing the first 1 MB of this document. Download the original to read the complete file.';
      $('#reader-notice').hidden = false;
    }
    if (anchor) {
      let decoded;
      try { decoded = decodeURIComponent(anchor); } catch { decoded = anchor; }
      $('#reader-content').querySelectorAll('[id]').forEach(element => {
        if (element.id === headingId(decoded)) element.scrollIntoView({ block: 'start' });
      });
    } else $('#reader').scrollTop = 0;
  } catch (error) {
    if (request !== state.readerRequest) return;
    $('#reader-content').replaceChildren(node('p', 'error-banner', `Could not open this document: ${error.message}`));
  }
}

async function uploadFiles(files) {
  if (state.uploading || !files.length) return;
  if (!state.library) { showError('Load the workspace before uploading documents.'); return; }
  state.uploading = true;
  $('#upload-button').disabled = true;
  $('#dropzone').disabled = true;
  $('#upload-results').replaceChildren();
  let uploaded = 0;
  for (const file of files) {
    const result = node('div', 'upload-result', file.name);
    const status = node('span', '', 'Saving original...');
    result.append(status);
    $('#upload-results').append(result);
    try {
      if (file.size > state.library.maxUploadBytes) throw new Error('This document exceeds the 20 MB limit.');
      await api(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': state.library.token },
        body: file,
      });
      status.textContent = 'Saved locally. Ready for agent ingestion.';
      uploaded++;
    } catch (error) {
      result.classList.add('failed');
      status.textContent = error.message;
    }
  }
  state.uploading = false;
  $('#file-input').value = '';
  await loadLibrary();
  if (uploaded) toast(`${uploaded} ${uploaded === 1 ? 'document' : 'documents'} added to your source library.`);
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); });
$('#refresh-button').addEventListener('click', loadLibrary);
$('#upload-button').addEventListener('click', () => $('#file-input').click());
$('#dropzone').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', event => uploadFiles([...event.target.files]));
$('#open-index').addEventListener('click', () => openDocument('wiki/index.md'));
$('#close-reader').addEventListener('click', () => $('#reader').close());
$('#reader').addEventListener('close', () => { ++state.readerRequest; });
$('#copy-path').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.selectedPath.replaceAll('/', '\\')); toast('Relative document path copied.'); }
  catch (error) { toast(`Could not copy the path: ${error.message}`); }
});
let searchTimer;
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadLibrary, 220); });
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (viewInfo[view]) setView(view);
});
window.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('#reader').open && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    $('#search-input').focus();
  }
});
for (const event of ['dragenter', 'dragover']) $('#dropzone').addEventListener(event, event => {
  event.preventDefault();
  if (!state.uploading) $('#dropzone').classList.add('drag-over');
});
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('drag-over'));
$('#dropzone').addEventListener('drop', event => {
  event.preventDefault();
  $('#dropzone').classList.remove('drag-over');
  uploadFiles([...event.dataTransfer.files]);
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('#upload-button').disabled = true;
$('#dropzone').disabled = true;
$('#open-index').disabled = true;
setView(location.hash.slice(1));
loadLibrary();
