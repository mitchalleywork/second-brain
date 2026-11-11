import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import http from 'node:http';
import { createAppServer } from './server.js';

function requestStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

async function workspace(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'second-brain-ui-test-'));
  const root = path.join(temporary, 'workspace');
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  for (const directory of ['raw/sources', 'raw/assets', 'wiki/concepts']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'wiki', 'index.md'), '# Index\n\n## Concepts\n');
  await fs.writeFile(path.join(root, 'wiki', 'log.md'), '# Log\n\nOriginal log.\n');
  await fs.writeFile(path.join(root, 'raw', 'sources', '.gitkeep'), '');
  server = createAppServer({ root, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${base}/api/library`)).json();
  return {
    root, temporary, base,
    upload: (name, body, extra = {}) => fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': initial.token, ...extra },
      body,
    }),
    get: relative => fetch(`${base}${relative}`),
  };
}

test('startup readiness identifies the exact workspace without reading document contents', async t => {
  const fixture = await workspace(t);
  const response = await fixture.get('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    application: 'work-second-brain', status: 'ready', workspaceRoot: fixture.root,
  });
  assert.equal(await requestStatus(`${fixture.base}/api/health`, { Origin: 'https://untrusted.example' }), 403);
  await fs.rename(path.join(fixture.root, 'wiki'), path.join(fixture.root, 'wiki-unavailable'));
  assert.equal((await fixture.get('/api/health')).status, 404);
});

test('uploads preserve original bytes, reject duplicates, and do not ingest or edit the wiki', async t => {
  const fixture = await workspace(t);
  const original = Buffer.from('# Research notes\r\n\r\nA useful observation.\r\n');
  const saved = await fixture.upload('research.md', original);
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).path, 'raw/sources/research.md');
  assert.deepEqual(await fs.readFile(path.join(fixture.root, 'raw', 'sources', 'research.md')), original);
  const duplicate = await fixture.upload('research.md', 'replacement');
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /never overwritten/);
  assert.deepEqual(await fs.readFile(path.join(fixture.root, 'raw', 'sources', 'research.md')), original);
  assert.deepEqual(await fs.readdir(path.join(fixture.root, '.uploads')), []);
  assert.equal(await fs.readFile(path.join(fixture.root, 'wiki', 'log.md'), 'utf8'), '# Log\n\nOriginal log.\n');
  const library = await (await fixture.get('/api/library')).json();
  assert.equal(library.stats.sources, 1);
  assert.equal(library.stats.pages, 0);
  assert.equal(library.entries.length, 3);
  assert.equal(library.entries.find(entry => entry.kind === 'source').title, 'Research notes');
  const preview = await (await fixture.get('/api/document?path=raw%2Fsources%2Fresearch.md')).json();
  assert.equal(preview.content, original.toString());
});

test('binary documents and Unicode filenames round-trip as attachments without pretending to extract text', async t => {
  const fixture = await workspace(t);
  const name = 'r\u00e9sum\u00e9 notes.pdf';
  const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff, 0x80]);
  assert.equal((await fixture.upload(name, original)).status, 201);
  const query = encodeURIComponent(`raw/sources/${name}`);
  const metadata = await (await fixture.get(`/api/document?path=${query}`)).json();
  assert.equal(metadata.previewable, false);
  assert.equal(metadata.content, null);
  const download = await fixture.get(`/api/download?path=${query}`);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
});

test('search finds text and wiki claims, searches binary filenames only, and reports truncated previews', async t => {
  const fixture = await workspace(t);
  await fs.writeFile(path.join(fixture.root, 'wiki', 'concepts', 'concept-learning.md'),
    '# Learning loop\n\nUpdated: 2026-11-11\n\nA spaced repetition workflow.');
  await fixture.upload('interview.txt', 'The customer needs a better handoff.');
  await fixture.upload('quarterly-report.pdf', Buffer.from('spaced repetition inside a binary'));
  const wikiMatches = await (await fixture.get('/api/library?q=spaced%20repetition')).json();
  assert.deepEqual(wikiMatches.entries.map(entry => entry.path), ['wiki/concepts/concept-learning.md']);
  assert.match(wikiMatches.entries[0].snippet, /spaced repetition/);
  const textMatches = await (await fixture.get('/api/library?q=HANDOFF')).json();
  assert.equal(textMatches.entries[0].name, 'interview.txt');
  assert.equal((await (await fixture.get('/api/library?q=quarterly')).json()).entries[0].previewable, false);
  const longText = 'first-page-marker\n' + 'x'.repeat(1024 * 1024) + '\nlast-page-marker';
  await fixture.upload('long.txt', longText);
  const preview = await (await fixture.get('/api/document?path=raw/sources/long.txt')).json();
  assert.equal(preview.truncated, true);
  assert.equal(Buffer.byteLength(preview.content), 1024 * 1024);
  assert.equal((await (await fixture.get('/api/library?q=first-page-marker')).json()).entries.length, 1);
  assert.equal((await (await fixture.get('/api/library?q=last-page-marker')).json()).entries.length, 0);
});

test('invalid, empty, unsupported, oversized, and unauthorized uploads leave no source files', async t => {
  const fixture = await workspace(t, { maxUploadBytes: 1024 });
  for (const name of ['../escape.md', '..\\escape.md', 'CON.txt', 'trailing .', '.hidden.md', 'bad:name.txt']) {
    assert.equal((await fixture.upload(name, 'invalid')).status, 400, name);
  }
  assert.equal((await fixture.upload('script.exe', 'invalid')).status, 415);
  assert.equal((await fixture.upload('empty.md', '')).status, 400);
  assert.equal((await fixture.upload('large.txt', Buffer.alloc(1025))).status, 413);
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); },
  });
  const chunked = await fetch(`${fixture.base}/api/upload?name=chunked.txt`, {
    method: 'POST', duplex: 'half', body: stream,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': (await (await fixture.get('/api/library')).json()).token },
  });
  assert.equal(chunked.status, 413);
  assert.equal((await fixture.upload('no-token.md', 'invalid', { 'X-Workspace-Token': 'wrong' })).status, 403);
  assert.deepEqual(await fs.readdir(path.join(fixture.root, 'raw', 'sources')), ['.gitkeep']);
});

test('library paths cannot traverse out, expose hidden files, or follow directory links', async t => {
  const fixture = await workspace(t);
  const privateDirectory = path.join(fixture.temporary, 'private');
  await fs.mkdir(privateDirectory);
  await fs.writeFile(path.join(privateDirectory, 'private.txt'), 'Do not serve this.');
  await fs.symlink(privateDirectory, path.join(fixture.root, 'raw', 'sources', 'shortcut'), 'junction');
  for (const relative of ['../private/private.txt', 'wiki/../../private/private.txt', 'raw/sources/../.gitkeep', 'C:\\private.txt', 'raw/sources/.gitkeep']) {
    const query = encodeURIComponent(relative);
    assert.equal((await fixture.get(`/api/download?path=${query}`)).status, 400, relative);
    assert.equal((await fixture.get(`/api/document?path=${query}`)).status, 400, relative);
  }
  assert.equal((await fixture.get('/api/download?path=raw/sources/shortcut/private.txt')).status, 403);
  const library = await (await fixture.get('/api/library')).json();
  assert.equal(library.entries.some(entry => entry.name === 'private.txt'), false);
  assert.equal((await fixture.get('/.git/config')).status, 404);
});

test('local origin protections reject cross-site writes and DNS rebinding; HTML sources are text, not executable pages', async t => {
  const fixture = await workspace(t);
  const foreign = await fixture.upload('foreign.md', 'invalid', { Origin: 'https://untrusted.example' });
  assert.equal(foreign.status, 403);
  assert.equal(await requestStatus(`${fixture.base}/api/library`, { Host: 'untrusted.example' }), 403);
  assert.equal(await requestStatus(`${fixture.base}/api/library`, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await requestStatus(`${fixture.base}/`, { 'Sec-Fetch-Site': 'cross-site' }), 200);
  const html = '<script>alert("not executable")</script>';
  assert.equal((await fixture.upload('notes.html', html)).status, 201);
  const preview = await fixture.get('/api/document?path=raw/sources/notes.html');
  assert.match(preview.headers.get('content-type'), /^application\/json/);
  assert.equal((await preview.json()).content, html);
  const home = await fixture.get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
});
