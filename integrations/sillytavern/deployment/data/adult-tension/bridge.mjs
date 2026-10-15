import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const skill = path.join(root, 'upstream/skill/adult-tension');
export const commands = ['doctor', 'version', 'list-worlds', 'new-game', 'get-context', 'commit-turn', 'undo-turn', 'save-slot', 'load-slot', 'list-slots', 'delete-slot', 'list-sessions', 'export-save', 'import-save', 'set-boundary', 'set-safety', 'set-preferences', 'status'];
export const documents = ['SKILL.md', 'references/commands.md', 'references/operations.md', 'references/narrative.md', 'references/worlds.md', 'references/custom_world.md', 'references/troubleshooting.md'];
const queues = new Map();
const inside = (child, parent) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export async function runCommand(command, input, directory) {
    directory = path.resolve(directory);
    if (!commands.includes(command)) throw new Error('Unsupported runtime command');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be a JSON object');
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 262144) throw new Error('Input exceeds 256 KiB');
    const payload = structuredClone(input);
    if (command === 'import-save' || command === 'export-save') {
        const exports = path.join(directory, 'exports');
        if (payload.path) {
            const target = path.resolve(exports, payload.path);
            if (!inside(target, exports) || path.extname(target).toLowerCase() !== '.json') throw new Error('File transfers are restricted to this game\'s exports directory; use the Import button for another file');
            await fs.mkdir(path.dirname(target), { recursive: true });
            const realParent = await fs.realpath(path.dirname(target));
            if (!inside(realParent, await fs.realpath(exports))) throw new Error('Export path traverses a link');
            const existing = await fs.lstat(target).catch(() => null);
            if (existing?.isSymbolicLink()) throw new Error('Linked files cannot be imported or overwritten');
            payload.path = target;
        }
    }
    payload.encoding_check = '汉字';
    await fs.mkdir(directory, { recursive: true });
    const previous = queues.get(directory) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
        const child = spawn('C:\\Windows\\py.exe', ['-3', path.join(skill, 'scripts/adult_tension.py'), command, '--json', '--input-file', '-', '--data-dir', directory], {
            windowsHide: true, cwd: root, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = ''; let stderr = ''; let limitReached = false;
        const timer = setTimeout(() => { limitReached = true; child.kill(); }, 60000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => { stdout += data; if (stdout.length > 4 * 1024 * 1024) { limitReached = true; child.kill(); } });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', () => {
            clearTimeout(timer);
            if (limitReached) return reject(new Error('Runtime limit reached; retry with the same request_id'));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Runtime did not return JSON: ' + stderr)); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(Buffer.from(JSON.stringify(payload), 'utf8'));
    }));
    queues.set(directory, operation);
    try { return await operation; } finally { if (queues.get(directory) === operation) queues.delete(directory); }
}

export const info = { id: 'adult-tension', name: 'Adult Tension Local Bridge', description: 'Fixed-command bridge to the original Python and SQLite runtime.' };
export async function init(router) {
    const directoryFor = request => {
        if (!request.user?.directories?.root) throw new Error('Authenticated user directory unavailable');
        return path.resolve(request.user.directories.root, 'adult-tension');
    };
    router.get('/info', async (request, response) => {
        try { response.json({ installed: true, revision: 'e46412d8c4cc354c3e2ba71a600559231539552e', commands, documents, data_directory: directoryFor(request) }); }
        catch (error) { response.status(403).json({ error: error.message }); }
    });
    router.post('/document', async (request, response) => {
        const name = request.body?.name;
        if (!documents.includes(name)) return response.status(400).json({ error: 'Unknown bundled document' });
        try { response.json({ name, text: await fs.readFile(path.join(skill, name), 'utf8') }); }
        catch { response.status(500).json({ error: 'Bundled document unavailable' }); }
    });
    router.post('/command', async (request, response) => {
        try {
            const input = request.body?.input ?? {};
            if (request.body?.command === 'delete-slot' && request.body?.user_confirmed_delete !== true) return response.status(400).json({ error: 'Deleting a save requires the local confirmation dialog' });
            response.json(await runCommand(request.body?.command, input, directoryFor(request)));
        } catch (error) { response.status(400).json({ ok: false, data: null, error: { code: 'BRIDGE_ERROR', message: error.message } }); }
    });
    router.post('/export-file', async (request, response) => {
        try {
            const folder = path.join(directoryFor(request), 'exports');
            const name = request.body?.name;
            if (typeof name !== 'string' || name !== path.basename(name) || !name.endsWith('.json')) throw new Error('Invalid export filename');
            const file = path.join(folder, name);
            if (!inside(await fs.realpath(file), await fs.realpath(folder))) throw new Error('Export path escaped its directory');
            response.type('application/json').send(await fs.readFile(file));
        } catch (error) { response.status(400).json({ error: error.message }); }
    });
    router.post('/import-file', async (request, response) => {
        try {
            const content = request.body?.content;
            if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 262144) throw new Error('Import must be a JSON file under 256 KiB');
            JSON.parse(content); // Validate syntax without reserializing: Python preserves 1.0 differently from JavaScript.
            const directory = directoryFor(request);
            const folder = path.resolve(directory, 'exports');
            await fs.mkdir(folder, { recursive: true });
            const name = 'import-' + randomUUID() + '.json';
            await fs.writeFile(path.join(folder, name), content, { encoding: 'utf8', flag: 'wx' });
            response.json(await runCommand('import-save', { request_id: 'r_' + randomUUID().replaceAll('-', ''), path: name }, directory));
        } catch (error) { response.status(400).json({ error: error.message }); }
    });
}
