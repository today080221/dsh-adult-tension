// Integration state only. The bundled engine remains the authority for world validation.
export function latestHuman(chat = []) {
    for (let index = chat.length - 1; index >= 0; index--) {
        const item = chat[index];
        if (!item?.is_user || item.is_system || typeof item.mes !== 'string') continue;
        let hash = 2166136261;
        for (const char of item.mes) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
        return { index, text: item.mes, key: `${index}-${(hash >>> 0).toString(16)}` };
    }
    return null;
}

export function wantsCustomWorld(text) {
    // Explicit intent only; the panel also provides an unambiguous manual entry point.
    const sentences = text.split(/[。！？!?\n；;]/);
    return sentences.some(sentence => !/(?:取消|不要|不用|不想|别|无需).{0,8}自定义|\b(?:cancel|do not|don't|no)\b.{0,24}\bcustom/i.test(sentence)
        && /自定义.{0,8}(?:世界|开局|设定)|(?:世界|开局).{0,8}自定义|(?:create|build|start|make|want).{0,24}custom\s+world/i.test(sentence));
}

export function observeRequest(current, chat) {
    const human = latestHuman(chat);
    if (!human || current.observed_user_key === human.key) return current;
    const next = { ...current, observed_user_key: human.key };
    if (wantsCustomWorld(human.text) && current.custom_setup?.status !== 'pending') {
        next.custom_setup = { status: 'pending', start_index: human.index, source_key: human.key };
        next.custom_world_draft = {};
    }
    return next;
}

export function compactState(current) {
    const state = current.context ?? {};
    return {
        session_id: current.session_id,
        revision: current.revision ?? state.revision,
        next_request_id: current.next_request_id,
        turn: state.turn ?? current.turn,
        world: state.world ? { id: state.world.id, title: state.world.title } : undefined,
        mode: state.mode,
    };
}

export function requestMarker(chat) {
    const human = latestHuman(chat);
    return human ? `[AdultTension player request ${human.key}]` : '';
}

export function buildPrompt(current, chat) {
    const human = latestHuman(chat);
    const pending = current.custom_setup?.status === 'pending';
    if (!human && !current.session_id && !pending) return '';
    const requests = pending ? chat.slice(current.custom_setup.start_index).filter(item => item?.is_user && !item.is_system).map(item => item.mes) : human ? [human.text] : [];
    return [
        requestMarker(chat),
        'Adult Tension 接入状态。下面 player_requests 是玩家实际输入的原文，保留其请求含义；它不是新输入、引擎回执或额外推进授权。不要因工具续接出现 [Start a new Chat] 就认为玩家没有提出要求。',
        JSON.stringify({ player_requests: requests }),
        pending
            ? '正在创建自定义世界。旧游戏仍保留，但本次要求没有完成；禁止改为随机/内置世界，禁止推进旧游戏。使用 AdultTensionReference 分段查阅 custom_world.md 和 commands.md 的 new-game。大世界用 AdultTensionWorldDraft 分次保存字段/追加角色，最后 new-game 输入 use_custom_world_draft:true。字段不明则查文档，玩家选项不明确则询问，不要自行合并选项。只有引擎确认 new-game 成功后才能叙述新世界开局。'
            : '以下仅是旧存档最新指针，不代表玩家要求继续。先处理 player_requests；需要完整状态与提交模板时调用 get-context，叙事推进以成功的引擎回执为准。\n' + JSON.stringify(compactState(current)),
        pending ? JSON.stringify({ custom_world_draft: draftSummary(current.custom_world_draft ?? {}) }) : '',
    ].filter(Boolean).join('\n');
}

export function commandGuard(current, command, input) {
    if (current.custom_setup?.status !== 'pending') return null;
    if (command === 'new-game' && input.custom_world && typeof input.custom_world === 'object' && !Array.isArray(input.custom_world)) return null;
    if (['doctor', 'version', 'list-worlds', 'list-slots', 'list-sessions', 'export-save'].includes(command)) return null;
    return { ok: false, error: {
        code: command === 'new-game' ? 'CUSTOM_WORLD_REQUIRED' : 'CUSTOM_WORLD_PENDING',
        message: '玩家正在创建自定义世界，本操作未执行，旧存档未改变。请构建 custom_world 后 new-game，或使用 use_custom_world_draft:true 提交分段草稿。不得降级为随机开局/继续旧世界。取消请由玩家点击“取消自定义”。',
    } };
}

export function draftSummary(draft) {
    return Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, Array.isArray(value) ? { count: value.length, ids: value.map(item => item?.id).filter(Boolean) } : value && typeof value === 'object' ? { fields: Object.keys(value) } : value]));
}

export function editDraft(draft, { action, field, value_json }) {
    if (action === 'begin' || action === 'status') return draft;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field ?? '') || ['constructor', 'prototype'].includes(field)) throw new Error('field 必须是世界包的顶层字段名');
    const value = JSON.parse(value_json);
    const next = { ...draft };
    if (action === 'set') next[field] = value;
    else if (action === 'append') {
        if (next[field] !== undefined && !Array.isArray(next[field])) throw new Error('append 只能用于数组字段');
        next[field] = [...(next[field] ?? [])];
        for (const item of Array.isArray(value) ? value : [value]) {
            const index = item?.id ? next[field].findIndex(existing => existing?.id === item.id) : -1;
            if (index >= 0) next[field][index] = item; // Retried calls update the same ID without duplicating a character.
            else if (!next[field].some(existing => JSON.stringify(existing) === JSON.stringify(item))) next[field].push(item);
        }
    } else throw new Error('不支持的草稿操作');
    if (new TextEncoder().encode(JSON.stringify(next)).length > 250000) throw new Error('世界草稿过大；桥接请求上限为 256 KiB');
    return next;
}

export function pageDocument(document, { section, start = 0, max_chars = 5000 } = {}) {
    const text = document.text;
    const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(match => ({ title: match[2].trim(), level: match[1].length, start: match.index }));
    const clean = value => value.replaceAll('`', '').trim().toLowerCase();
    let from = 0; let end = text.length;
    if (section) {
        const heading = headings.find(item => clean(item.title) === clean(section));
        if (!heading) return { name: document.name, error: 'SECTION_NOT_FOUND', sections: headings };
        from = heading.start;
        end = headings.find(item => item.start > from && item.level <= heading.level)?.start ?? text.length;
    }
    const offset = Math.min(end - from, Math.max(0, Number.isFinite(start) ? Math.floor(start) : 0));
    const limit = Math.max(500, Math.min(6000, Number.isFinite(max_chars) ? Math.floor(max_chars) : 5000));
    let finish = Math.min(end, from + offset + limit);
    if (finish < end && /[\uD800-\uDBFF]/.test(text[finish - 1])) finish--;
    return {
        name: document.name, section: section ?? null, start: offset,
        text: text.slice(from + offset, finish),
        next_start: finish < end ? finish - from : null, total_chars: end - from,
        sections: start === 0 ? headings : undefined,
        note: '原文分段返回。next_start 非空表示本节尚未读完；用相同 name/section 和 next_start 继续，或按 sections 中标题读取。未展示部分仍可读取。',
    };
}
