import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PREVIEW_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml']);
const UPLOAD_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.pdf', '.docx', '.xlsx', '.pptx', '.rtf']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const CATEGORY_NAMES = {
  sources: 'Source notes',
  entities: 'Entities',
  concepts: 'Concepts',
  questions: 'Questions',
  synthesis: 'Synthesis',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function confinedPath(root, relative, { directory = false } = {}) {
  const segments = relative.split('/');
  const allowed = relative.startsWith('raw/sources/') || relative.startsWith('raw/assets/') ||
    relative.startsWith('wiki/') || (directory && ['raw/sources', 'raw/assets', 'wiki', '.uploads'].includes(relative));
  if (!allowed || segments.some(segment => !segment || segment === '.' || segment === '..' ||
    /[\\:\0]/.test(segment) || (segment.startsWith('.') && relative !== '.uploads'))) {
    throw new HttpError(400, 'This path is outside the document library.');
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new HttpError(403, 'Symbolic links are not served by the library.');
  }
  const stat = await fs.stat(current);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new HttpError(404, 'Document not found.');
  }
  return current;
}

async function readPreview(filename, size) {
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { content: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > PREVIEW_LIMIT };
  } finally {
    await handle.close();
  }
}

async function describe(root, relative, query = '') {
  const filename = await confinedPath(root, relative);
  const stat = await fs.stat(filename);
  const name = path.basename(filename);
  const extension = path.extname(name).toLowerCase();
  const previewable = TEXT_EXTENSIONS.has(extension);
  const preview = previewable ? await readPreview(filename, stat.size) : null;
  const kind = relative.startsWith('raw/') ? 'source' :
    ['wiki/index.md', 'wiki/log.md'].includes(relative) ? 'system' : 'wiki';
  const category = relative.startsWith('raw/assets/') ? 'Attachments' :
    kind === 'source' ? 'Documents' : kind === 'system' ? 'Workspace' :
    CATEGORY_NAMES[relative.split('/')[1]] || 'Wiki';
  const title = ['.md', '.markdown'].includes(extension) ?
    preview.content.match(/^#\s+(.+)\r?$/m)?.[1]?.trim() || name : name;
  const searchable = `${name}\n${title}\n${relative}\n${preview?.content || ''}`.toLowerCase();
  let snippet = '';
  if (query && preview) {
    const position = preview.content.toLowerCase().indexOf(query.toLowerCase());
    if (position >= 0) {
      const start = Math.max(0, position - 65);
      snippet = `${start ? '...' : ''}${preview.content.slice(start, position + query.length + 110).replace(/\s+/g, ' ')}${position + query.length + 110 < preview.content.length ? '...' : ''}`;
    }
  }
  return {
    entry: { path: relative, name, title, extension, kind, category, size: stat.size,
      modified: stat.mtime.toISOString(), previewable, snippet },
    matches: !query || searchable.includes(query.toLowerCase()),
    preview,
  };
}

async function library(root, query) {
  const entries = [];
  async function walk(relative) {
    const directory = await confinedPath(root, relative, { directory: true });
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const next = `${relative}/${item.name}`;
      if (item.isDirectory()) await walk(next);
      else if (item.isFile()) entries.push(await describe(root, next, query));
    }
  }
  for (const directory of ['raw/sources', 'raw/assets', 'wiki']) await walk(directory);
  const all = entries.map(item => item.entry).sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
  return {
    entries: entries.filter(item => item.matches).map(item => item.entry)
      .sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path)),
    stats: {
      sources: all.filter(item => item.kind === 'source').length,
      pages: all.filter(item => item.kind === 'wiki').length,
      lastUpdated: all[0]?.modified || null,
    },
    links: all.map(({ path: filePath, title, kind }) => ({ path: filePath, title, kind })),
  };
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        if (!oversized) {
          oversized = true;
          chunks.length = 0;
          reject(new HttpError(413, `This document exceeds the upload limit (${limit.toLocaleString('en-US')} bytes).`));
        }
      } else if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, 'The upload was interrupted. Please try again.')));
  });
}

function validateFilename(name) {
  if (!name || name.length > 180 || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
    /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
    throw new HttpError(400, 'Use a normal document filename without reserved characters (180 characters maximum).');
  }
  if (!UPLOAD_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    throw new HttpError(415, 'Supported uploads: Markdown, text, PDF, DOCX, XLSX, PPTX, RTF, CSV, JSON, HTML, XML, and YAML.');
  }
}

export function createAppServer({ root = PROJECT_ROOT, maxUploadBytes = UPLOAD_LIMIT } = {}) {
  root = path.resolve(root);
  const token = randomUUID();
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const allowedHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
      if (!allowedHosts.includes(request.headers.host)) {
        throw new HttpError(403, 'Only requests from this local workspace are allowed.');
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      const publicAsset = STATIC_FILES.has(url.pathname) && ['GET', 'HEAD'].includes(request.method);
      if (!publicAsset && ((request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site')) {
        throw new HttpError(403, 'Only requests from this local workspace are allowed.');
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        if (request.headers['x-workspace-token'] !== token) throw new HttpError(403, 'Refresh the workspace before uploading.');
        if (request.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'Upload a document as binary file content.');
        const name = url.searchParams.get('name');
        validateFilename(name);
        if (Number(request.headers['content-length']) > maxUploadBytes) {
          throw new HttpError(413, `This document exceeds the upload limit (${maxUploadBytes.toLocaleString('en-US')} bytes).`);
        }
        const directory = await confinedPath(root, 'raw/sources', { directory: true });
        const destination = path.join(directory, name);
        const body = await readBody(request, maxUploadBytes);
        if (!body.length) throw new HttpError(400, 'Empty documents cannot be uploaded.');
        await fs.mkdir(path.join(root, '.uploads'), { recursive: true });
        const stagingDirectory = await confinedPath(root, '.uploads', { directory: true });
        const temporary = path.join(stagingDirectory, randomUUID());
        await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        try {
          await fs.link(temporary, destination);
        } finally {
          await fs.unlink(temporary);
        }
        json(response, 201, { path: `raw/sources/${name}`, message: 'Document saved. The original will not be overwritten.' });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'This action is not supported.');
      }
      if (url.pathname === '/api/health') {
        for (const directory of ['raw/sources', 'raw/assets', 'wiki']) {
          await confinedPath(root, directory, { directory: true });
        }
        json(response, 200, { application: 'work-second-brain', status: 'ready', workspaceRoot: root });
      } else if (url.pathname === '/api/library') {
        const query = (url.searchParams.get('q') || '').trim();
        if (query.length > 200) throw new HttpError(400, 'Search queries must be 200 characters or fewer.');
        json(response, 200, { ...await library(root, query), token, maxUploadBytes, workspace: path.basename(root) });
      } else if (url.pathname === '/api/document') {
        const { entry, preview } = await describe(root, url.searchParams.get('path') || '');
        json(response, 200, { ...entry, content: preview?.content ?? null, truncated: preview?.truncated ?? false });
      } else if (url.pathname === '/api/download') {
        const filename = await confinedPath(root, url.searchParams.get('path') || '');
        const name = path.basename(filename);
        const stat = await fs.stat(filename);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        });
        if (request.method === 'HEAD') response.end();
        else await pipeline(createReadStream(filename), response);
      } else if (STATIC_FILES.has(url.pathname)) {
        const [name, type] = STATIC_FILES.get(url.pathname);
        const body = await fs.readFile(path.join(PROJECT_ROOT, 'public', name));
        response.writeHead(200, { 'Content-Type': type });
        response.end(request.method === 'HEAD' ? undefined : body);
      } else {
        throw new HttpError(404, 'Page not found.');
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : 500;
      const message = error instanceof HttpError ? error.message :
        status === 404 ? 'Document or folder not found.' :
        status === 409 ? 'A document with this filename already exists. Rename your new file; originals are never overwritten.' :
        'The workspace could not complete this action. Check the server terminal for details.';
      if (status === 500) console.error('Workspace request failed:', error);
      request.resume();
      if (!response.headersSent && !response.destroyed) json(response, status, { error: message });
      else if (!response.destroyed) response.destroy(error);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.on('error', error => {
      console.error(`Cannot start the workspace on port ${port}: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Second Brain is ready at http://127.0.0.1:${port}`);
      console.log('Local storage only. No AI service or external connection is used.');
    });
  }
}
