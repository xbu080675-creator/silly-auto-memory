const MODULE = 'silly_auto_memory';
const PROMPT_ID = 'silly_auto_memory_recall';
const META_LAST_SOURCE = 'silly_auto_memory_last_source';
const VERSION = '0.1.4';

const DEFAULTS = Object.freeze({
    enabled: true,
    autoExtract: true,
    backendUrl: 'http://127.0.0.1:27183',
    retrieveLimit: 10,
    minScore: 0.17,
    queryMessages: 6,
    injectionDepth: 4,
    maxPromptChars: 6500,
    allowGlobal: false,
    extractionResponseTokens: 1400,
    debug: false,
});

let extractionInFlight = false;
let extractionTimer = null;
let initialized = false;
let lastRecallMemories = [];
let lastRecallQuery = '';
let lastRecallAt = null;

function ctx() {
    return globalThis.SillyTavern?.getContext?.();
}

function log(...args) {
    if (settings().debug) console.debug('[AutoMemory]', ...args);
}

function settings() {
    const c = ctx();
    if (!c) return structuredClone(DEFAULTS);
    c.extensionSettings ??= {};
    c.extensionSettings[MODULE] ??= {};
    const s = c.extensionSettings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!(k in s)) s[k] = v;
    }
    return s;
}

function saveSettings() {
    ctx()?.saveSettingsDebounced?.();
}

function eventTypes() {
    const c = ctx();
    return c?.event_types || c?.eventTypes || {};
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[ch]);
}

function stableCharacterKey() {
    const c = ctx();
    if (!c) return 'character:unknown';
    if (c.groupId) return `group:${String(c.groupId)}`;

    const index = Number(c.characterId);
    const ch = Number.isFinite(index) ? c.characters?.[index] : undefined;
    const stable = ch?.avatar || ch?.data?.name || ch?.name || c.name2 || `index-${c.characterId ?? 'unknown'}`;
    return `character:${String(stable).replace(/\s+/g, '_')}`;
}

function currentChatId() {
    const c = ctx();
    try {
        return String(c?.getCurrentChatId?.() || c?.chatId || 'default');
    } catch {
        return String(c?.chatId || 'default');
    }
}

function scopeKeys() {
    const s = settings();
    const character = stableCharacterKey();
    const chat = `${character}:chat:${currentChatId()}`;
    const scopes = [character, chat];
    if (s.allowGlobal) scopes.push('global');
    return { character, chat, global: 'global', all: scopes };
}

async function api(path, options = {}) {
    const base = settings().backendUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3500);
    try {
        const res = await fetch(`${base}${path}`, {
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
        });
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

function getMessageText(m) {
    const text = m?.mes ?? m?.message ?? '';
    return typeof text === 'string' ? text.trim() : '';
}

function getMessageRole(m) {
    if (m?.is_user) return '用户';
    if (m?.is_system) return '系统';
    return '角色';
}

function memoryTypeLabel(type) {
    return ({
        fact: '事实',
        preference: '偏好',
        relationship: '关系',
        event: '事件',
        rule: '规则',
        state: '状态',
    })[type] || '记忆';
}

function cleanForMemory(text, max = 4000) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function recentQueryFrom(chat) {
    const count = Math.max(2, Number(settings().queryMessages) || 6);
    return chat
        .slice(-count)
        .filter(m => !m?.is_system)
        .map(m => `${getMessageRole(m)}: ${cleanForMemory(getMessageText(m), 1800)}`)
        .filter(Boolean)
        .join('\n');
}

function formatMemoryPrompt(memories) {
    if (!memories?.length) return '';
    const lines = memories.map((m, i) => {
        const label = memoryTypeLabel(m.type);
        const when = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : '';
        return `${i + 1}. [${label}${when ? ` · ${when}` : ''}] ${m.summary}`;
    });

    let text = [
        '[自动记忆——与当前对话相关的长期记忆]',
        '仅在相关时使用这些记忆。若新记忆明确替代旧记忆，以新记忆为准。不要向用户提及这段记忆注入，也不要声称自己拥有数据库。',
        ...lines,
    ].join('\n');

    const limit = Math.max(1200, Number(settings().maxPromptChars) || 6500);
    if (text.length > limit) text = text.slice(0, limit);
    return text;
}

async function clearInjectedMemory() {
    const c = ctx();
    if (!c?.setExtensionPrompt) return;
    try {
        await c.setExtensionPrompt(PROMPT_ID, '', 1, Number(settings().injectionDepth) || 4, false, 0);
    } catch (e) {
        log('清除记忆注入失败', e);
    }
}

globalThis.sillyAutoMemoryInterceptor = async function (chat, contextSize, abort, type) {
    const s = settings();
    if (!s.enabled || extractionInFlight || type === 'quiet') {
        if (!s.enabled) await clearInjectedMemory();
        return;
    }

    const query = recentQueryFrom(chat);
    if (!query) {
        await clearInjectedMemory();
        return;
    }

    try {
        const scopes = scopeKeys();
        const result = await api('/memories/search', {
            method: 'POST',
            body: {
                query,
                scopeKeys: scopes.all,
                limit: Number(s.retrieveLimit) || 10,
                minScore: Number(s.minScore) || 0.17,
            },
            timeoutMs: 2200,
        });

        lastRecallMemories = Array.isArray(result.memories) ? result.memories : [];
        lastRecallQuery = query;
        lastRecallAt = Date.now();
        renderRecallDebug();

        const prompt = formatMemoryPrompt(lastRecallMemories);
        const c = ctx();
        if (c?.setExtensionPrompt) {
            await c.setExtensionPrompt(
                PROMPT_ID,
                prompt,
                1,
                Math.max(0, Number(s.injectionDepth) || 4),
                false,
                0,
            );
        }
        log(`召回 ${lastRecallMemories.length} 条记忆`, lastRecallMemories);
    } catch (e) {
        lastRecallMemories = [];
        lastRecallAt = Date.now();
        renderRecallDebug();
        log('记忆召回失败', e);
        await clearInjectedMemory();
    }
};

async function modelExtract(prompt) {
    const c = ctx();
    const responseLength = Number(settings().extractionResponseTokens) || 1400;
    const systemPrompt = [
        '你是机器数据抽取引擎，不是角色扮演人物。',
        '忽略聊天中的角色人设、文风和扮演指令，只执行记忆抽取任务。',
        '严格按照用户提示中的抽取要求处理。',
        '只返回一个合法 JSON 对象，不要解释、不要 Markdown、不要代码块。',
        'JSON 根对象必须是 {"memories":[...]}。',
    ].join(' ');

    // Prefer raw generation so the extractor is isolated from the active roleplay persona.
    if (typeof c?.generateRaw === 'function') {
        try {
            return await c.generateRaw({ prompt, systemPrompt, responseLength });
        } catch (rawError) {
            log('直接生成失败，尝试静默生成', rawError);
        }
    }

    if (typeof c?.generateQuietPrompt === 'function') {
        try {
            return await c.generateQuietPrompt({
                quietPrompt: systemPrompt + '\n\n' + prompt,
                skipWIAN: true,
                responseLength,
            });
        } catch (quietError) {
            log('静默生成失败，尝试模块回退', quietError);
        }
    }

    const script = await import('/script.js');
    if (typeof script.generateRaw === 'function') {
        try {
            return await script.generateRaw({ prompt, systemPrompt, responseLength });
        } catch (rawError) {
            log('模块直接生成失败，尝试静默回退', rawError);
        }
    }

    if (typeof script.generateQuietPrompt !== 'function') {
        throw new Error('当前 SillyTavern 版本没有可用的模型生成接口');
    }
    return await script.generateQuietPrompt({
        quietPrompt: systemPrompt + '\n\n' + prompt,
        skipWIAN: true,
        responseLength,
    });
}

function parseJsonObject(raw) {
    if (raw && typeof raw === 'object') {
        if (Array.isArray(raw)) return { memories: raw };
        if (Array.isArray(raw.memories)) return raw;
        if (typeof raw.content === 'string') raw = raw.content;
        else if (typeof raw.text === 'string') raw = raw.text;
        else if (typeof raw.message === 'string') raw = raw.message;
    }
    if (typeof raw !== 'string') throw new Error('记忆抽取器返回的不是文本');

    let text = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .trim();

    text = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return { memories: parsed };
        return parsed;
    } catch {}

    const firstObj = text.indexOf('{');
    const lastObj = text.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) {
        try {
            const parsed = JSON.parse(text.slice(firstObj, lastObj + 1));
            if (Array.isArray(parsed)) return { memories: parsed };
            return parsed;
        } catch {}
    }

    const firstArr = text.indexOf('[');
    const lastArr = text.lastIndexOf(']');
    if (firstArr >= 0 && lastArr > firstArr) {
        try {
            return { memories: JSON.parse(text.slice(firstArr, lastArr + 1)) };
        } catch {}
    }

    const preview = text.replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`未找到合法 JSON。模型输出：${preview || '（空）'}`);
}

function buildExtractionPrompt(contextText, targetText, characterName, userName) {
    return `你是一个用于角色扮演/聊天系统的自动记忆抽取器。

请从【目标轮次】中提取以后维持剧情连续性时有用的信息。不要求用户明确说“记住这个”。
不要过分保守：只要是自然通过叙述或对话建立、并且以后可能会被再次提及的重要信息，就应保存。

以下内容通常值得保存：
- 关于 ${userName}、${characterName}、其他具名人物、地点、物品、组织或世界设定的稳定事实
- 以后可能有用的偏好、习惯、边界、目标、恐惧、观点、长期行为或个人规则
- 人际关系变化、承诺、冲突、和解、信任变化、称呼、身份、角色或社会关系
- 有意义的事件、决定、发现、计划、物品得失、当前任务、地点变化或剧情结果
- 持续有效的世界规则、设定规则或角色规则
- 对近期剧情连续性有帮助的临时状态

不要把整段对话概括成摘要。不要保存无关紧要的动作、寒暄、填充内容、纯文风、没有变化的重复信息、常识、明显不确定的猜测、密码、API 密钥、支付信息、精确住址或高度敏感秘密。

记忆类型：
- fact：事实
- preference：偏好
- relationship：关系
- event：事件
- rule：规则
- state：状态

每条记忆必须包含以下 JSON 字段：
- type：fact | preference | relationship | event | rule | state
- subject：简短、明确的主体
- predicate：简短、稳定的属性或关系
- object：简短的值
- summary：一句能脱离上下文独立理解的中文记忆，名字要写清楚，不要使用需要上下文才能理解的代词
- keywords：3-10 个用于召回的关键词、别名或同义词
- importance：1-5 的整数；普通连续性信息用 3，明显重要的发展用 4，重大转折才用 5
- confidence：0-1
- scope："character" 表示跟随当前角色跨聊天保留；"chat" 表示只属于当前剧情分支/场景；"global" 仅用于明确属于用户本人的普遍事实或偏好
- mode：只有当本条明确修改/推翻同一 subject+predicate 的旧值时使用 "replace"，否则使用 "append"
- ttl_days：长期记忆填 0；确实是临时的 state 可填 3-30

有实际剧情信息的轮次通常提取 1-4 条。只有当这一轮确实没有任何以后值得使用的信息时，才返回 {"memories":[]}。
只返回严格合法的 JSON，不要 Markdown，不要额外解释。

【目标轮次之前的上下文】（只用于确认人物和指代）：
${contextText || '（无）'}

【目标轮次】：
${targetText}`;
}

function findLatestTurn(chat) {
    let a = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i]?.is_user && !chat[i]?.is_system && getMessageText(chat[i])) {
            a = i;
            break;
        }
    }
    if (a < 0) return null;

    let u = -1;
    for (let i = a - 1; i >= 0; i--) {
        if (chat[i]?.is_user && getMessageText(chat[i])) {
            u = i;
            break;
        }
    }
    if (u < 0) return null;
    return { userIndex: u, assistantIndex: a, user: chat[u], assistant: chat[a] };
}

function canonicalCandidate(raw, scopes) {
    if (!raw || typeof raw !== 'object') return null;
    const allowedTypes = new Set(['fact', 'preference', 'relationship', 'event', 'rule', 'state']);
    const allowedModes = new Set(['append', 'replace']);

    const summary = cleanForMemory(raw.summary, 500);
    const subject = cleanForMemory(raw.subject, 120);
    const predicate = cleanForMemory(raw.predicate, 120);
    const object = cleanForMemory(raw.object, 300);
    if (!summary || !subject || !predicate) return null;

    let scope = String(raw.scope || 'character').toLowerCase();
    if (scope === 'global' && !settings().allowGlobal) scope = 'character';
    const scopeKey = scope === 'chat' ? scopes.chat : scope === 'global' ? scopes.global : scopes.character;

    return {
        type: allowedTypes.has(raw.type) ? raw.type : 'fact',
        subject,
        predicate,
        object,
        summary,
        keywords: Array.isArray(raw.keywords)
            ? raw.keywords.map(x => cleanForMemory(x, 80)).filter(Boolean).slice(0, 10)
            : [],
        importance: Math.min(5, Math.max(1, Math.round(Number(raw.importance) || 2))),
        confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0.7)),
        mode: allowedModes.has(raw.mode) ? raw.mode : 'append',
        ttlDays: Math.min(3650, Math.max(0, Math.round(Number(raw.ttl_days) || 0))),
        scopeKey,
    };
}

async function extractLatestTurn({ force = false } = {}) {
    const s = settings();
    if ((!s.enabled || !s.autoExtract) && !force) return;
    if (extractionInFlight) return;

    const c = ctx();
    const chat = c?.chat || [];
    const turn = findLatestTurn(chat);
    if (!turn) return;

    const chatId = currentChatId();
    const sourceKey = `${chatId}:${turn.userIndex}:${turn.assistantIndex}`;
    const metadata = c.chatMetadata || {};
    if (!force && metadata[META_LAST_SOURCE] === sourceKey) return;

    const contextStart = Math.max(0, turn.userIndex - 4);
    const contextText = chat
        .slice(contextStart, turn.userIndex)
        .filter(m => !m?.is_system)
        .map(m => `${getMessageRole(m)}: ${cleanForMemory(getMessageText(m), 1600)}`)
        .join('\n');

    const targetText = [
        `用户：${cleanForMemory(getMessageText(turn.user), 5000)}`,
        `角色：${cleanForMemory(getMessageText(turn.assistant), 5000)}`,
    ].join('\n');

    const cName = c.name2 || c.characters?.[Number(c.characterId)]?.name || '当前角色';
    const uName = c.name1 || '用户';

    extractionInFlight = true;
    updateStatus('正在抽取记忆…');
    try {
        const extractionPrompt = buildExtractionPrompt(contextText, targetText, cName, uName);
        let raw = await modelExtract(extractionPrompt);
        let parsed;
        try {
            parsed = parseJsonObject(raw);
        } catch (firstParseError) {
            const repairPrompt = [
                '把下面这段不规范的记忆抽取结果转换为严格合法的 JSON。',
                '只返回 {"memories":[...]}，不要附加任何其他内容。',
                '如果其中没有值得保存的记忆，返回 {"memories":[]}。',
                '',
                String(raw || '').slice(0, 8000),
            ].join('\n');
            log('正在修复不规范的抽取结果', raw);
            raw = await modelExtract(repairPrompt);
            parsed = parseJsonObject(raw);
        }
        const scopes = scopeKeys();
        const memories = (parsed.memories || [])
            .map(m => canonicalCandidate(m, scopes))
            .filter(Boolean)
            .slice(0, 12);

        const result = await api('/memories/upsert', {
            method: 'POST',
            body: { sourceKey, memories },
            timeoutMs: 4000,
        });

        const current = ctx();
        if (current?.chatMetadata) {
            current.chatMetadata[META_LAST_SOURCE] = sourceKey;
            if (typeof current.saveMetadata === 'function') {
                await current.saveMetadata();
            }
        }
        updateStatus(`本次写入 ${result.changed ?? memories.length} 条 · 当前有效 ${result.activeCount ?? '?'} 条`);
        log('记忆抽取结果', result, memories);
        await refreshMemoryList();
    } catch (e) {
        console.warn('[自动记忆] 抽取失败：', e);
        updateStatus(`抽取失败：${e.message || e}`);
    } finally {
        extractionInFlight = false;
    }
}

function scheduleExtraction() {
    clearTimeout(extractionTimer);
    extractionTimer = setTimeout(() => extractLatestTurn().catch(console.warn), 700);
}

function updateStatus(text) {
    const el = document.getElementById('sam_status');
    if (el) el.textContent = text;
}

function renderRecallDebug() {
    const box = document.getElementById('sam_recall_debug');
    if (!box) return;

    if (!lastRecallAt) {
        box.innerHTML = '<div class="sam-empty">还没有执行过记忆召回。</div>';
        return;
    }

    const time = new Date(lastRecallAt).toLocaleTimeString();
    const count = lastRecallMemories.length;
    const items = lastRecallMemories.slice(0, 8).map((m, i) =>
        '<div class="sam-recall-item">' +
        '<b>' + (i + 1) + '.</b> ' + escapeHtml(m.summary || '') +
        '</div>'
    ).join('');

    box.innerHTML =
        '<div class="sam-recall-title">最近一次召回：' + count + ' 条 · ' + time + '</div>' +
        (count ? items : '<div class="sam-empty">本轮没有找到达到相关度阈值的记忆。</div>');
}

async function testBackend() {
    updateStatus('正在测试 Termux 后端…');
    try {
        const h = await api('/health', { timeoutMs: 1800 });
        updateStatus(`后端已连接 · v${h.version} · 当前有效记忆 ${h.activeCount} 条`);
    } catch (e) {
        updateStatus(`后端未连接：${e.message || e}`);
    }
}

function bindSetting(id, key, coerce = v => v) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = settings();
    if (el.type === 'checkbox') el.checked = Boolean(s[key]);
    else el.value = s[key];

    const event = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(event, () => {
        s[key] = coerce(el.type === 'checkbox' ? el.checked : el.value);
        saveSettings();
    });
}

async function refreshMemoryList() {
    const box = document.getElementById('sam_memory_list');
    if (!box) return;

    try {
        const scopes = scopeKeys();
        const result = await api('/memories/list', {
            method: 'POST',
            body: { scopeKeys: scopes.all, limit: 80 },
            timeoutMs: 2500,
        });

        box.innerHTML = '';
        if (!result.memories?.length) {
            box.innerHTML = '<div class="sam-empty">当前角色/聊天范围内还没有有效记忆。</div>';
            return;
        }

        for (const m of result.memories) {
            const row = document.createElement('div');
            row.className = 'sam-memory-row';

            const main = document.createElement('div');
            main.className = 'sam-memory-main';
            const meta = document.createElement('div');
            meta.className = 'sam-memory-meta';
            meta.textContent = `${memoryTypeLabel(m.type)} · 重要度 ${m.importance} · 累计记录 ${m.mentions ?? 1} 次`;
            const summary = document.createElement('div');
            summary.className = 'sam-memory-summary';
            summary.textContent = m.summary;
            main.append(meta, summary);

            const del = document.createElement('button');
            del.className = 'menu_button sam-delete';
            del.textContent = '×';
            del.title = '删除这条记忆';
            del.addEventListener('click', async () => {
                await api('/memories/delete', { method: 'POST', body: { id: m.id } });
                await refreshMemoryList();
                await testBackend();
            });

            row.append(main, del);
            box.appendChild(row);
        }
    } catch (e) {
        box.innerHTML = `<div class="sam-empty">后端不可用：${escapeHtml(e.message || e)}</div>`;
    }
}

async function clearCurrentScope() {
    if (!confirm('确定删除当前角色和当前聊天范围内的全部有效记忆吗？')) return;
    const scopes = scopeKeys();
    await api('/memories/clear', {
        method: 'POST',
        body: { scopeKeys: [scopes.character, scopes.chat] },
    });
    await refreshMemoryList();
    await testBackend();
}

async function exportMemories() {
    const base = settings().backendUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/export`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `silly-auto-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function mountUi() {
    if (document.getElementById('sam_settings')) return;

    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.id = 'sam_settings';
    wrap.className = 'extension_container';
    wrap.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>自动记忆（Termux）</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="sam-grid">
            <label><input id="sam_enabled" type="checkbox"> 启用自动召回</label>
            <label><input id="sam_auto" type="checkbox"> 回复后自动记忆</label>
            <label><input id="sam_global" type="checkbox"> 允许跨角色用户记忆</label>
          </div>

          <label class="sam-label">Termux 后端地址
            <input id="sam_backend" class="text_pole" type="text">
          </label>

          <div class="sam-grid sam-numbers">
            <label>召回数量 <input id="sam_limit" class="text_pole" type="number" min="1" max="30"></label>
            <label>最低相关度 <input id="sam_score" class="text_pole" type="number" step="0.01" min="0" max="1"></label>
            <label>检索最近消息数 <input id="sam_query_messages" class="text_pole" type="number" min="2" max="20"></label>
            <label>注入深度 <input id="sam_depth" class="text_pole" type="number" min="0" max="20"></label>
          </div>

          <div class="sam-actions">
            <button id="sam_test" class="menu_button">测试后端</button>
            <button id="sam_extract" class="menu_button">提取最新一轮</button>
            <button id="sam_refresh" class="menu_button">刷新记忆</button>
            <button id="sam_export" class="menu_button">导出记忆</button>
            <button id="sam_clear" class="menu_button redWarningBG">清空当前范围</button>
          </div>

          <div id="sam_status" class="sam-status">尚未检测</div>
          <div class="sam-recall-panel">
            <div class="sam-recall-heading">召回调试</div>
            <div id="sam_recall_debug" class="sam-recall-debug"><div class="sam-empty">还没有执行过记忆召回。</div></div>
          </div>
          <div id="sam_memory_list" class="sam-memory-list"></div>
        </div>
      </div>`;

    host.appendChild(wrap);

    bindSetting('sam_enabled', 'enabled', Boolean);
    bindSetting('sam_auto', 'autoExtract', Boolean);
    bindSetting('sam_global', 'allowGlobal', Boolean);
    bindSetting('sam_backend', 'backendUrl', String);
    bindSetting('sam_limit', 'retrieveLimit', v => Math.max(1, Math.min(30, Number(v) || 10)));
    bindSetting('sam_score', 'minScore', v => Math.max(0, Math.min(1, Number(v) || 0)));
    bindSetting('sam_query_messages', 'queryMessages', v => Math.max(2, Math.min(20, Number(v) || 6)));
    bindSetting('sam_depth', 'injectionDepth', v => Math.max(0, Math.min(20, Number(v) || 4)));

    document.getElementById('sam_test')?.addEventListener('click', testBackend);
    document.getElementById('sam_extract')?.addEventListener('click', () => extractLatestTurn({ force: true }));
    document.getElementById('sam_refresh')?.addEventListener('click', refreshMemoryList);
    document.getElementById('sam_clear')?.addEventListener('click', clearCurrentScope);
    document.getElementById('sam_export')?.addEventListener('click', async () => {
        try { await exportMemories(); } catch (e) { updateStatus(`导出失败：${e.message || e}`); }
    });

    setTimeout(() => {
        testBackend();
        refreshMemoryList();
        renderRecallDebug();
    }, 500);
}

function registerEvents() {
    const c = ctx();
    const ev = eventTypes();
    if (!c?.eventSource) return;

    if (ev.MESSAGE_RECEIVED) c.eventSource.on(ev.MESSAGE_RECEIVED, scheduleExtraction);
    if (ev.MESSAGE_SWIPED) c.eventSource.on(ev.MESSAGE_SWIPED, scheduleExtraction);
    if (ev.MESSAGE_EDITED) c.eventSource.on(ev.MESSAGE_EDITED, scheduleExtraction);

    if (ev.CHAT_CHANGED) {
        c.eventSource.on(ev.CHAT_CHANGED, async () => {
            await clearInjectedMemory();
            setTimeout(refreshMemoryList, 200);
        });
    }
}

export function onActivate() {
    if (initialized) return;
    initialized = true;
    settings();
    mountUi();
    registerEvents();

    // Some hosts mount extension settings a little later.
    setTimeout(mountUi, 1000);
    console.info(`[自动记忆] v${VERSION} 已启用`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(onActivate, 0), { once: true });
} else {
    setTimeout(onActivate, 0);
}
