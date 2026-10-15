import { observeRequest, buildPrompt, commandGuard, pageDocument, draftSummary, editDraft, latestHuman, requestMarker } from './context-guard.js?v=1.1.0';

const KEY = 'adult_tension';
const API = '/api/plugins/adult-tension';
const commandNames = ['doctor', 'version', 'list-worlds', 'new-game', 'get-context', 'commit-turn', 'undo-turn', 'save-slot', 'load-slot', 'list-slots', 'delete-slot', 'list-sessions', 'export-save', 'import-save', 'set-boundary', 'set-safety', 'set-preferences', 'status'];
const documentNames = ['SKILL.md', 'references/commands.md', 'references/operations.md', 'references/narrative.md', 'references/worlds.md', 'references/custom_world.md', 'references/troubleshooting.md'];
const context = () => SillyTavern.getContext();
const active = () => Boolean(context().characters[context().characterId]?.data?.extensions?.adult_tension);
let enabled = false;

async function api(route, body) {
    const result = await fetch(API + route, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify(body) });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error?.message ?? data.error ?? '本地引擎请求失败');
    return data;
}

function snapshot() { return context().chatMetadata[KEY] ?? {}; }
function refreshRequest() {
    if (!active()) return snapshot();
    const current = snapshot();
    const next = observeRequest(current, context().chat);
    if (next !== current) {
        context().chatMetadata[KEY] = next;
        context().saveMetadata();
    }
    return next;
}
function inject() {
    const ctx = context();
    const current = refreshRequest();
    ctx.setExtensionPrompt('adult-tension-live-state', active() ? buildPrompt(current, ctx.chat) : '', 1, 0, false, 0);
    const label = document.getElementById('adult_tension_status');
    if (label) label.textContent = active()
        ? (current.custom_setup?.status === 'pending' ? '自定义世界待创建 · 旧存档暂停推进' : current.session_id ? '已连接当前游戏 · 回合 ' + (current.context?.turn ?? current.turn ?? 0) : '已连接 · 可以发送“开局”')
        : '选择 Adult Tension 角色后启用';
}

async function remember(result) {
    if (!active() || !result.ok || !result.data) return;
    const data = result.data;
    const current = snapshot();
    const session = data.session_id ?? data.context?.session_id;
    const next = session && session !== current.session_id
        ? { custom_setup: current.custom_setup, custom_world_draft: current.custom_world_draft, observed_user_key: current.observed_user_key }
        : { ...current };
    for (const field of ['session_id', 'revision', 'next_request_id', 'turn', 'context', 'commit_template', 'skip_template', 'save']) {
        if (data[field] !== undefined) next[field] = data[field];
    }
    if (session) next.session_id = session;
    if (!next.session_id) return;
    context().chatMetadata[KEY] = next;
    await context().saveMetadata();
    inject();
}

async function run({ command, input_json = '{}' }) {
    if (!active()) throw new Error('请先选择 Adult Tension 角色');
    const current = refreshRequest();
    let input;
    try {
        input = JSON.parse(input_json);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input_json 必须是 JSON 对象');
    } catch (error) { return JSON.stringify({ ok: false, error: { code: 'INVALID_JSON', message: error.message } }); }
    if (command === 'new-game' && input.use_custom_world_draft === true) input.custom_world = current.custom_world_draft ?? {};
    delete input.use_custom_world_draft;
    const blocked = commandGuard(current, command, input);
    if (blocked) return JSON.stringify(blocked);
    let confirmed = false;
    if (command === 'delete-slot') {
        confirmed = Boolean(await context().callGenericPopup('确定删除存档「' + String(input.name ?? '').replace(/[<>]/g, '') + '」吗？', context().POPUP_TYPE.CONFIRM));
        if (!confirmed) return JSON.stringify({ ok: false, error: { code: 'CANCELLED', message: '玩家取消删除，存档未改变' } });
    }
    const result = await api('/command', { command, input, user_confirmed_delete: confirmed });
    await remember(result);
    if (command === 'new-game' && input.custom_world && result.ok) {
        context().chatMetadata[KEY] = { ...snapshot(), custom_setup: { ...snapshot().custom_setup, status: 'completed' } };
        await context().saveMetadata();
    }
    inject();
    return JSON.stringify(result);
}

async function readReference(options) {
    const current = refreshRequest();
    const requested = { ...options };
    if (current.custom_setup?.status === 'pending' && requested.name === 'references/commands.md' && !requested.section) requested.section = 'new-game';
    return JSON.stringify(pageDocument(await api('/document', { name: requested.name }), requested));
}

async function worldDraft(options) {
    if (!active()) throw new Error('请先选择 Adult Tension 角色');
    const current = refreshRequest();
    if (current.custom_setup?.status !== 'pending') return JSON.stringify({ ok: false, error: { code: 'CUSTOM_WORLD_NOT_REQUESTED', message: '尚无创建自定义世界的请求。请让玩家发送要求或点击“自定义世界”。' } });
    try {
        const draft = editDraft(current.custom_world_draft ?? {}, options);
        context().chatMetadata[KEY] = { ...current, custom_world_draft: draft };
        await context().saveMetadata();
        inject();
        return JSON.stringify({ ok: true, data: { draft: draftSummary(draft), bytes: new TextEncoder().encode(JSON.stringify(draft)).length, committed: false, next: '继续分段保存字段。准备好后 AdultTensionCommand new-game 使用 use_custom_world_draft:true；由原引擎完整校验，失败不会随机开局。' } });
    } catch (error) { return JSON.stringify({ ok: false, error: { code: 'DRAFT_ERROR', message: error.message } }); }
}

function guardPrompt({ chat, dryRun }) {
    if (!active() || dryRun) return;
    const human = latestHuman(context().chat);
    if (!human) return;
    const marker = requestMarker(context().chat);
    const retained = chat.some(message => {
        const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('\n') : '';
        return content.includes(marker) || (message.role === 'user' && content.includes(human.text));
    });
    if (!retained) {
        context().stopGeneration();
        toastr.error('上下文容量不足，当前玩家要求已被挤出。本次生成已停止；请减少本轮参考资料或增加可用上下文后重试。', 'Adult Tension');
    }
}

function register() {
    const ctx = context();
    ctx.registerFunctionTool({ name: 'AdultTensionCommand', displayName: 'Adult Tension 本地引擎',
        description: 'Run one Adult Tension command. Pass the exact command input as a JSON string. Call doctor once before the first game. Runtime replies are authoritative. Never simulate tool results. Read AdultTensionReference by section for fields. For custom worlds, pass custom_world to new-game or build it in parts with AdultTensionWorldDraft and pass use_custom_world_draft:true. A pending custom request cannot continue an old game or fall back to a built-in world. File paths are restricted to game exports.',
        parameters: { type: 'object', properties: { command: { type: 'string', enum: commandNames }, input_json: { type: 'string', description: 'JSON object as a string, e.g. {}. Write operations require request_id; session writes also require session_id and expected_revision from the latest runtime result.' } }, required: ['command', 'input_json'] },
        action: run, shouldRegister: active, stealth: false, formatMessage: () => '更新世界与存档',
    });
    ctx.registerFunctionTool({ name: 'AdultTensionReference', displayName: 'Adult Tension 参考资料',
        description: 'Read original game rules in bounded pages, never whole large manuals at once. Use section with an exact heading from sections; use next_start as start to continue that section. commands.md section new-game describes creation; custom_world.md describes required fields. Do not invent fields or assume a partial page is the whole document.',
        parameters: { type: 'object', properties: { name: { type: 'string', enum: documentNames }, section: { type: 'string', description: 'Exact heading title, backticks optional, e.g. new-game or character_templates[] 的字段' }, start: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 500, maximum: 6000 } }, required: ['name'] },
        action: readReference, shouldRegister: active, stealth: false, formatMessage: () => '分段读取游戏规则',
    });
    ctx.registerFunctionTool({ name: 'AdultTensionWorldDraft', displayName: 'Adult Tension 自定义世界草稿',
        description: 'Assemble a requested custom world across multiple small calls to fit the model output budget. begin/status returns existing field/count summary; set replaces one top-level world field with parsed value_json; append adds array entries and updates existing entries with the same id. For large character_templates append one character per call. This only saves a draft, never starts or advances a game. To validate and create use AdultTensionCommand new-game with use_custom_world_draft:true. Read custom_world.md for schemas. Preserve player choices; ask about unresolved choices.',
        parameters: { type: 'object', properties: { action: { type: 'string', enum: ['begin', 'status', 'set', 'append'] }, field: { type: 'string' }, value_json: { type: 'string', description: 'JSON value for set, or an item/array of items for append' } }, required: ['action'] },
        action: worldDraft, shouldRegister: active, stealth: false, formatMessage: () => '保存自定义世界草稿',
    });
}

async function show(text) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;text-align:left;max-height:65vh;overflow:auto';
    pre.textContent = text;
    await context().callGenericPopup(pre, context().POPUP_TYPE.TEXT, '', { wide: true });
}

async function buttonAction(action) {
    try {
        if (!active() && action !== 'check') return show('先在角色列表选择 Adult Tension。');
        if (action === 'check') {
            const result = await api('/command', { command: 'doctor', input: {} });
            return show(result.ok ? '本地引擎正常。\n' + result.data.checks.map(item => item.message).join('\n') : JSON.stringify(result.error, null, 2));
        }
        const current = snapshot();
        if (action === 'custom' || action === 'cancel-custom') {
            const human = latestHuman(context().chat);
            context().chatMetadata[KEY] = { ...current, observed_user_key: human?.key,
                custom_setup: { status: action === 'custom' ? 'pending' : 'cancelled', start_index: current.custom_setup?.status === 'pending' ? current.custom_setup.start_index : context().chat.length, source_key: human?.key },
                custom_world_draft: action === 'custom' && current.custom_setup?.status !== 'pending' ? {} : current.custom_world_draft,
            };
            await context().saveMetadata(); inject();
            return show(action === 'custom' ? '已进入自定义世界准备。请在聊天中写世界、人物、模式等要求；大世界会分段保存草稿，再交给引擎验证。创建成功前不会推进旧存档。' : '已取消自定义准备。旧存档未改变；可以继续原游戏。');
        }
        if (action === 'worlds' || action === 'saves') {
            const result = await api('/command', { command: action === 'worlds' ? 'list-worlds' : 'list-slots', input: {} });
            return show(JSON.stringify(result.data ?? result.error, null, 2));
        }
        if (action === 'import') {
            if (current.custom_setup?.status === 'pending') return show('请先点击“取消自定义”，再导入其他存档。');
            const picker = document.createElement('input');
            picker.type = 'file'; picker.accept = '.json,application/json';
            picker.onchange = async () => {
                try {
                    const file = picker.files?.[0]; if (!file) return;
                    if (file.size > 262144) throw new Error('导入文件超过 256 KiB，请用原生 Skill 导入');
                    const result = await api('/import-file', { content: await file.text() });
                    await remember(result);
                    await show(result.ok ? '导入成功。可以发送“状态”或“继续”。' : JSON.stringify(result.error, null, 2));
                } catch (error) { await show(error.message); }
            };
            picker.click(); return;
        }
        if (!current.session_id) return show('还没有开局。可以发送“开局，日常，港口夜班”。');
        const command = action === 'export' ? 'export-save' : 'status';
        const result = await api('/command', { command, input: { session_id: current.session_id } });
        if (!result.ok) return show(JSON.stringify(result.error, null, 2));
        if (action === 'export') {
            const exported = result.data.path ?? result.data.file;
            if (typeof exported !== 'string') return show(JSON.stringify(result.data, null, 2));
            const name = exported.split(/[\\/]/).pop();
            const response = await fetch(API + '/export-file', { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ name }) });
            if (!response.ok) throw new Error('导出下载失败');
            const objectUrl = URL.createObjectURL(await response.blob());
            const link = document.createElement('a'); link.href = objectUrl; link.download = name; link.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
            return;
        }
        await remember(result);
        return show((result.data.lines ?? []).join('\n') || JSON.stringify(result.data, null, 2));
    } catch (error) { await show(error.message); }
}

function init() {
    if (enabled) return; enabled = true;
    register();
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (host) {
        const panel = document.createElement('div');
        panel.className = 'extension_container';
        panel.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Adult Tension · 世界与存档</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><p id="adult_tension_status"></p><div class="flex-container"><button class="menu_button" data-at="check">检查引擎</button><button class="menu_button" data-at="custom">自定义世界</button><button class="menu_button" data-at="cancel-custom">取消自定义</button><button class="menu_button" data-at="worlds">世界列表</button><button class="menu_button" data-at="state">当前状态</button><button class="menu_button" data-at="saves">存档列表</button><button class="menu_button" data-at="export">导出存档</button><button class="menu_button" data-at="import">导入存档</button></div><small>直接聊天即可开局、推进、存档和读档。引擎存档独立于聊天；修改或删除聊天消息不会自动回滚游戏，请说“刚才不算”来撤销回合。</small></div></div>';
        panel.querySelectorAll('[data-at]').forEach(button => {
            button.style.cssText = 'width:auto;min-width:88px;flex:0 0 auto;white-space:nowrap;margin:4px 2px;';
            button.addEventListener('click', () => buttonAction(button.dataset.at));
        });
        host.appendChild(panel);
    }
    const ctx = context();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, inject);
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, inject);
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, inject);
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, guardPrompt);
    inject();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
