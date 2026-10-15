import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { runCommand, root, skill, documents } from './bridge.mjs';
import { latestHuman, wantsCustomWorld, observeRequest, buildPrompt, pageDocument, editDraft, requestMarker } from '../default-user/extensions/adult-tension/context-guard.js';

const tests = [];
const pass = name => tests.push(name);
const directory = path.join(root, 'evidence', 'custom-world-integration-' + Date.now());
const originalWorld = JSON.parse(await fs.readFile(path.join(root, 'upstream/content-src/examples/custom_world.json'), 'utf8'));
const chat = [{ is_user: true, mes: '创建自定义世界：气象观测站。所有人物均为成年人；先整理要求，不要推进旧游戏。' }];
assert.equal(wantsCustomWorld(chat[0].mes), true);
for (const text of ['不要自定义世界，继续原游戏', '取消自定义', 'do not create a custom world', '普通开局', '继续']) assert.equal(wantsCustomWorld(text), false, text);
assert.equal(latestHuman([...chat, { is_user: true, is_system: true, mes: 'hidden' }, { is_user: false, mes: 'reply' }]).text, chat[0].mes);
pass('Explicit custom intent, negation, and real human message filtering');

let state = observeRequest({}, chat);
assert.equal(state.custom_setup.status, 'pending');
state = { ...state, custom_setup: { ...state.custom_setup, status: 'completed' } };
assert.equal(observeRequest(state, chat).custom_setup.status, 'completed');
pass('Successful setup is not rearmed by repeated generation events');

const docStats = [];
for (const name of documents) {
    const document = { name, text: await fs.readFile(path.join(skill, name), 'utf8') };
    let assembled = ''; let cursor = 0; let pages = 0;
    do {
        const part = pageDocument(document, { start: cursor });
        assert.ok(part.text.length <= 5000);
        assert.ok(JSON.stringify(part).length < 11000);
        assembled += part.text; pages++; cursor = part.next_start;
    } while (cursor !== null);
    assert.equal(assembled, document.text);
    docStats.push({ name, pages, characters: document.text.length });
}
const commandsDoc = { name: 'references/commands.md', text: await fs.readFile(path.join(skill, 'references/commands.md'), 'utf8') };
const creationSection = pageDocument(commandsDoc, { section: 'new-game' });
assert.ok(creationSection.text.startsWith('### `new-game`'));
assert.ok(creationSection.text.includes('custom_world'));
assert.ok(!creationSection.text.includes('### `save-slot`'));
assert.equal(pageDocument(commandsDoc, { section: 'nonexistent' }).error, 'SECTION_NOT_FOUND');
pass('Every original manual remains losslessly readable through bounded pages; exact sections work');

const draftA = editDraft({}, { action: 'append', field: 'character_templates', value_json: '{"id":"npc_a","label":"A"}' });
const draftB = editDraft(draftA, { action: 'append', field: 'character_templates', value_json: '{"id":"npc_a","label":"B"}' });
assert.equal(draftB.character_templates.length, 1);
assert.equal(draftB.character_templates[0].label, 'B');
assert.throws(() => editDraft({}, { action: 'set', field: '__proto__', value_json: '{}' }));
assert.throws(() => editDraft({ rules: 'wrong' }, { action: 'append', field: 'rules', value_json: '{}' }));
pass('Draft append retries update stable IDs; invalid fields and array targets are rejected');

const oldGame = await runCommand('new-game', { request_id: 'qa_old_world_20261016', mode: 'daily', seed: 19 }, directory);
assert.equal(oldGame.ok, true, JSON.stringify(oldGame.error));
const oldId = oldGame.data.session_id;
const tools = new Map(); const events = new Map(); let injected = ''; let stopped = 0; let errorToasts = 0; let backendCalls = 0;
const ctx = {
    characters: [{ data: { extensions: { adult_tension: true } } }], characterId: 0,
    chat, chatMetadata: { adult_tension: structuredClone(oldGame.data) },
    saveMetadata: async () => {}, getRequestHeaders: () => ({}),
    setExtensionPrompt: (name, text) => { injected = text; },
    registerFunctionTool: tool => tools.set(tool.name, tool),
    eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'MESSAGE_SENT', 'CHAT_COMPLETION_PROMPT_READY'].map(key => [key, key])),
    eventSource: { on: (name, callback) => events.set(name, callback) },
    stopGeneration: () => { stopped++; return true; },
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.document = { readyState: 'complete', getElementById: () => null };
globalThis.toastr = { error: () => { errorToasts++; } };
globalThis.fetch = async (url, options) => {
    const input = JSON.parse(options.body);
    if (url.endsWith('/command')) { backendCalls++; return { ok: true, json: async () => runCommand(input.command, input.input, directory) }; }
    if (url.endsWith('/document')) return { ok: true, json: async () => ({ name: input.name, text: await fs.readFile(path.join(skill, input.name), 'utf8') }) };
    throw new Error('Unexpected route: ' + url);
};
await import(pathToFileURL(path.join(root, '../default-user/extensions/adult-tension/index.js')).href);
assert.equal(tools.size, 3);
const invoke = async (name, input) => JSON.parse(await tools.get(name).action(input));
const command = (name, input) => invoke('AdultTensionCommand', { command: name, input_json: JSON.stringify(input) });
assert.equal(ctx.chatMetadata.adult_tension.custom_setup.status, 'pending');
assert.ok(injected.includes(chat[0].mes));
assert.ok(!injected.includes(oldId));
assert.ok(injected.length < 1800);
pass('Actual extension registers all tools and pins the custom request without injecting the old world');

const baselineCalls = backendCalls;
const blockedCommands = ['new-game', 'commit-turn', 'undo-turn', 'load-slot', 'import-save', 'set-boundary', 'set-safety', 'set-preferences', 'save-slot', 'delete-slot', 'get-context', 'status'];
for (const name of blockedCommands) {
    const result = await command(name, { session_id: oldId, request_id: 'qa_blocked_20261016', expected_revision: oldGame.data.revision });
    assert.equal(result.ok, false, name);
    assert.match(result.error.code, /^CUSTOM_WORLD_/);
}
assert.equal(backendCalls, baselineCalls);
const health = await command('doctor', {});
assert.equal(health.ok, true, JSON.stringify(health));
pass('Pending custom setup blocks random creation and all old-world mutations before backend dispatch');

const reference = await invoke('AdultTensionReference', { name: 'references/commands.md' });
assert.equal(reference.section, 'new-game');
assert.ok(reference.text.includes('custom_world'));
const invalidDraft = await command('new-game', { request_id: 'qa_empty_draft_20261016', mode: 'daily', use_custom_world_draft: true });
assert.equal(invalidDraft.ok, false);
assert.equal(ctx.chatMetadata.adult_tension.custom_setup.status, 'pending');
assert.equal(ctx.chatMetadata.adult_tension.session_id, oldId);
pass('Creation reference focuses on new-game; incomplete draft returns engine validation errors and preserves pending setup');

for (const [field, value] of Object.entries(originalWorld)) {
    if (field === 'character_templates') {
        for (const item of value) assert.equal((await invoke('AdultTensionWorldDraft', { action: 'append', field, value_json: JSON.stringify(item) })).ok, true);
    } else assert.equal((await invoke('AdultTensionWorldDraft', { action: 'set', field, value_json: JSON.stringify(value) })).ok, true);
}
assert.deepEqual(ctx.chatMetadata.adult_tension.custom_world_draft, originalWorld);
const created = await command('new-game', { request_id: 'qa_chunked_creation_20261016', mode: 'daily', seed: 12, use_custom_world_draft: true });
assert.equal(created.ok, true, JSON.stringify(created.error));
assert.notEqual(created.data.session_id, oldId);
assert.equal(ctx.chatMetadata.adult_tension.custom_setup.status, 'completed');
events.get('GENERATION_STARTED')();
assert.equal(ctx.chatMetadata.adult_tension.custom_setup.status, 'completed');
const refreshed = await command('get-context', { session_id: created.data.session_id });
assert.equal(refreshed.ok, true);
assert.ok(injected.includes(created.data.session_id));
assert.ok(!injected.includes('character_templates'));
assert.ok(injected.length < 1800);
pass('Incremental world draft reaches the real engine, creates the custom session, and releases the pending guard');

const oldAfter = await runCommand('get-context', { session_id: oldId }, directory);
assert.equal(oldAfter.ok, true);
assert.equal(oldAfter.data.revision, oldGame.data.revision);
assert.equal(oldAfter.data.context.turn, oldGame.data.context.turn);
pass('Original isolated game revision and turn remain unchanged');

const ready = events.get('CHAT_COMPLETION_PROMPT_READY');
ready({ chat: [{ role: 'system', content: '[Start a new Chat]\nold state' }], dryRun: true });
assert.equal(stopped, 0);
ready({ chat: [{ role: 'system', content: '[Start a new Chat]\nold state' }], dryRun: false });
assert.equal(stopped, 1);
assert.equal(errorToasts, 1);
ready({ chat: [{ role: 'system', content: injected }], dryRun: false });
ready({ chat: [{ role: 'user', content: [{ type: 'text', text: chat[0].mes }] }], dryRun: false });
assert.equal(stopped, 1);
pass('Prompt-ready guard stops a request with neither the player message nor its preserved copy; dry runs and retained requests pass');

chat.push({ is_user: true, mes: '继续查看天气。' });
events.get('MESSAGE_SENT')();
assert.ok(injected.includes(chat.at(-1).mes));
assert.ok(injected.includes(requestMarker(chat)));
ctx.characterId = 1;
events.get('CHAT_CHANGED')();
assert.equal(injected, '');
pass('New user messages refresh the preserved request; other characters receive no injection');

const report = { tested_at: new Date().toISOString(), isolated_directory: directory, passed: tests.length, tests, manuals: docStats,
    old_game_unchanged: true, real_custom_world_created: true, tested_actual_client_tool_callbacks: true,
    live_model_tested: false, user_chats_or_prompts_read: false, user_saves_modified: false };
await fs.writeFile(path.join(root, 'evidence/custom-world-integration.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
