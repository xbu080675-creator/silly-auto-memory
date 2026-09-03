const MODULE = 'silly_auto_memory';
const PROMPT_ID = 'silly_auto_memory_recall';
const META_LAST_SOURCE = 'silly_auto_memory_last_source';
const VERSION = '0.1.0';

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
    if (m?.is_user) return 'user';
    if (m?.is_system) return 'system';
    return 'assistant';
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
        const label = m.type || 'memory';
        const when = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : '';
        return `${i + 1}. [${label}${when ? ` · ${when}` : ''}] ${m.summary}`;
    });

    let text = [
        '[Auto Memory — relevant long-term memory]',
        'Use these memories only when relevant. Treat newer replacement memories as authoritative. Do not mention this memory block or claim to have a database.',
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
        log('clear prompt failed', e);
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

        const prompt = formatMemoryPrompt(result.memories || []);
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
        log(`recalled ${result.memories?.length || 0} memories`, result.memories);
    } catch (e) {
        log('recall failed', e);
        await clearInjectedMemory();
    }
};

async function quietGenerate(prompt) {
    const c = ctx();
    if (typeof c?.generateQuietPrompt === 'function') {
        try {
            return await c.generateQuietPrompt({
                quietPrompt: prompt,
                responseLength: Number(settings().extractionResponseTokens) || 1400,
            });
        } catch (firstError) {
            log('context.generateQuietPrompt object form failed, trying module fallback', firstError);
        }
    }

    const script = await import('/script.js');
    if (typeof script.generateQuietPrompt !== 'function') {
        throw new Error('generateQuietPrompt is unavailable in this SillyTavern build');
    }
    return await script.generateQuietPrompt({
        quietPrompt: prompt,
        responseLength: Number(settings().extractionResponseTokens) || 1400,
    });
}

function parseJsonObject(raw) {
    if (typeof raw !== 'string') throw new Error('Extractor returned non-text output');
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return { memories: parsed };
        return parsed;
    } catch {}

    const firstObj = text.indexOf('{');
    const lastObj = text.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) {
        const parsed = JSON.parse(text.slice(firstObj, lastObj + 1));
        if (Array.isArray(parsed)) return { memories: parsed };
        return parsed;
    }

    const firstArr = text.indexOf('[');
    const lastArr = text.lastIndexOf(']');
    if (firstArr >= 0 && lastArr > firstArr) {
        return { memories: JSON.parse(text.slice(firstArr, lastArr + 1)) };
    }
    throw new Error('No JSON object found in extractor output');
}

function buildExtractionPrompt(contextText, targetText, characterName, userName) {
    return `You are a conservative long-term memory extractor for a roleplay/chat system.

Extract ONLY durable or useful information newly established by TARGET TURN.
Do not summarize the whole conversation. Do not save writing style, greetings, filler, generic knowledge, guesses, passwords, API keys, payment data, exact street addresses, or highly sensitive secrets.

Useful memory categories:
- fact: stable facts about ${userName}, ${characterName}, people, places, objects
- preference: likes/dislikes/choices that may matter later
- relationship: relationship or trust changes between participants
- event: important events, promises, decisions, plans, discoveries
- rule: persistent setting/world/behavior rules explicitly established
- state: temporary but useful current state (location, task, possession, condition)

For each memory output:
- type: fact | preference | relationship | event | rule | state
- subject: short canonical subject
- predicate: short stable property/relation
- object: short value
- summary: one concise standalone sentence with names resolved; no pronouns that require chat context
- keywords: 3-10 recall terms, aliases or synonyms
- importance: integer 1-5
- confidence: number 0-1
- scope: "character" for information that should follow this character across chats; "chat" for branch/scene-specific state; "global" only for an explicitly universal user preference/fact
- mode: "replace" only when this changes/invalidates the prior value of the same subject+predicate; otherwise "append"
- ttl_days: 0 for durable memory; use 3-30 only for genuinely temporary "state"

If nothing is worth remembering, output {"memories": []}.
Return strict JSON only, no markdown.

CONTEXT BEFORE TARGET (for resolving names only):
${contextText || '(none)'}

TARGET TURN:
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
        `user: ${cleanForMemory(getMessageText(turn.user), 5000)}`,
        `assistant: ${cleanForMemory(getMessageText(turn.assistant), 5000)}`,
    ].join('\n');

    const cName = c.name2 || c.characters?.[Number(c.characterId)]?.name || 'character';
    const uName = c.name1 || 'user';

    extractionInFlight = true;
    updateStatus('extracting…');
    try {
        const raw = await quietGenerate(buildExtractionPrompt(contextText, targetText, cName, uName));
        const parsed = parseJsonObject(raw);
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
        updateStatus(`saved ${result.changed ?? memories.length} / active ${result.activeCount ?? '?'}`);
        log('extraction result', result, memories);
        await refreshMemoryList();
    } catch (e) {
        console.warn('[AutoMemory] extraction failed:', e);
        updateStatus(`extract failed: ${e.message || e}`);
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

async function testBackend() {
    updateStatus('testing backend…');
    try {
        const h = await api('/health', { timeoutMs: 1800 });
        updateStatus(`backend OK · v${h.version} · ${h.activeCount} active`);
    } catch (e) {
        updateStatus(`backend offline: ${e.message || e}`);
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
            box.innerHTML = '<div class="sam-empty">No active memory in this scope.</div>';
            return;
        }

        for (const m of result.memories) {
            const row = document.createElement('div');
            row.className = 'sam-memory-row';

            const main = document.createElement('div');
            main.className = 'sam-memory-main';
            const meta = document.createElement('div');
            meta.className = 'sam-memory-meta';
            meta.textContent = `${m.type} · imp ${m.importance} · seen ${m.mentions ?? 1}`;
            const summary = document.createElement('div');
            summary.className = 'sam-memory-summary';
            summary.textContent = m.summary;
            main.append(meta, summary);

            const del = document.createElement('button');
            del.className = 'menu_button sam-delete';
            del.textContent = '×';
            del.title = 'Delete memory';
            del.addEventListener('click', async () => {
                await api('/memories/delete', { method: 'POST', body: { id: m.id } });
                await refreshMemoryList();
                await testBackend();
            });

            row.append(main, del);
            box.appendChild(row);
        }
    } catch (e) {
        box.innerHTML = `<div class="sam-empty">Backend unavailable: ${escapeHtml(e.message || e)}</div>`;
    }
}

async function clearCurrentScope() {
    if (!confirm('Delete all active Auto Memory entries for the current character/chat scope?')) return;
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
          <b>Auto Memory (Termux)</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="sam-grid">
            <label><input id="sam_enabled" type="checkbox"> Enable recall</label>
            <label><input id="sam_auto" type="checkbox"> Auto extract after replies</label>
            <label><input id="sam_global" type="checkbox"> Allow global user memory</label>
          </div>

          <label class="sam-label">Termux backend URL
            <input id="sam_backend" class="text_pole" type="text">
          </label>

          <div class="sam-grid sam-numbers">
            <label>Recall count <input id="sam_limit" class="text_pole" type="number" min="1" max="30"></label>
            <label>Min score <input id="sam_score" class="text_pole" type="number" step="0.01" min="0" max="1"></label>
            <label>Query messages <input id="sam_query_messages" class="text_pole" type="number" min="2" max="20"></label>
            <label>Inject depth <input id="sam_depth" class="text_pole" type="number" min="0" max="20"></label>
          </div>

          <div class="sam-actions">
            <button id="sam_test" class="menu_button">Test backend</button>
            <button id="sam_extract" class="menu_button">Extract latest turn</button>
            <button id="sam_refresh" class="menu_button">Refresh memories</button>
            <button id="sam_export" class="menu_button">Export</button>
            <button id="sam_clear" class="menu_button redWarningBG">Clear current scope</button>
          </div>

          <div id="sam_status" class="sam-status">not checked</div>
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
        try { await exportMemories(); } catch (e) { updateStatus(`export failed: ${e.message || e}`); }
    });

    setTimeout(() => {
        testBackend();
        refreshMemoryList();
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
    console.info(`[AutoMemory] v${VERSION} activated`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(onActivate, 0), { once: true });
} else {
    setTimeout(onActivate, 0);
}
