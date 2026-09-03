'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VERSION = '0.2.1';
const HOST = process.env.SILLY_MEMORY_HOST || '127.0.0.1';
const PORT = Number(process.env.SILLY_MEMORY_PORT || 27183);
const HOME = process.env.SILLY_MEMORY_HOME || path.join(os.homedir(), '.silly-auto-memory');
const DB_FILE = path.join(HOME, 'memories.json');

let db = { version: 1, memories: [] };
let writeChain = Promise.resolve();

function now() { return Date.now(); }
function id() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }

function normalizeText(s) {
    return String(s || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(input) {
    const text = normalizeText(input);
    const out = new Set();

    for (const word of text.match(/[a-z0-9][a-z0-9._-]*/g) || []) {
        if (word.length >= 2) out.add(word);
    }

    for (const block of text.match(/[\u3400-\u9fff]+/g) || []) {
        const chars = [...block];
        if (chars.length === 1) out.add(chars[0]);
        if (chars.length >= 2 && chars.length <= 8) out.add(chars.join(''));
        for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
        for (let i = 0; i < chars.length - 2; i++) out.add(chars[i] + chars[i + 1] + chars[i + 2]);
    }
    return [...out];
}

function jaccard(a, b) {
    const A = new Set(tokenize(a));
    const B = new Set(tokenize(b));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const x of A) if (B.has(x)) hit++;
    return hit / (A.size + B.size - hit);
}

function lexicalScore(query, m) {
    const queryText = normalizeText(query);
    const queryTokens = new Set(tokenize(queryText));
    const memText = [m.summary, m.subject, m.predicate, m.object, ...(m.keywords || [])].join(' ');
    const memTokens = new Set(tokenize(memText));

    if (!queryTokens.size || !memTokens.size) return { score: 0, matched: [] };

    const matched = [];
    for (const t of queryTokens) if (memTokens.has(t)) matched.push(t);

    let exactBoost = 0;
    const boostPhrase = (value, amount) => {
        const v = normalizeText(value);
        if (v.length < 2) return;
        if (queryText.includes(v)) exactBoost += amount;
    };

    boostPhrase(m.subject, 0.15);
    boostPhrase(m.object, 0.12);
    for (const kw of m.keywords || []) boostPhrase(kw, 0.16);
    exactBoost = Math.min(0.36, exactBoost);

    if (!matched.length && exactBoost === 0) return { score: 0, matched: [] };

    if (queryTokens.size >= 5 && matched.length < 2 && exactBoost < 0.16) {
        return { score: 0, matched };
    }

    const overlap = matched.length / Math.sqrt(queryTokens.size * memTokens.size);
    const importance = Math.max(0.2, Math.min(1, (Number(m.importance) || 1) / 5));
    const confidence = Math.max(0, Math.min(1, Number(m.confidence) || 0.5));
    const ageDays = Math.max(0, (now() - (m.updatedAt || m.createdAt || now())) / 86400000);
    const recency = 1 / (1 + ageDays / 120);

    let score = overlap * 0.82 + exactBoost;
    const quality = 0.86 + importance * 0.06 + confidence * 0.04 + recency * 0.04;
    score = Math.max(0, Math.min(1, score * quality));

    return { score, matched: matched.slice(0, 12) };
}

function isExpired(m) {
    return Boolean(m.expiresAt && m.expiresAt <= now());
}

function activeMemories() {
    return db.memories.filter(m => m.active !== false && !isExpired(m));
}

async function loadDb() {
    await fsp.mkdir(HOME, { recursive: true });
    try {
        const raw = await fsp.readFile(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.memories)) {
            db = parsed;
            for (const m of db.memories) {
                m.tokens = candidateTokens(m);
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            const backup = `${DB_FILE}.corrupt-${Date.now()}`;
            try { await fsp.rename(DB_FILE, backup); } catch {}
            console.error('[AutoMemory] database was invalid; moved aside:', backup, e.message);
        }
        await persist();
    }
}

function persist() {
    writeChain = writeChain.then(async () => {
        const tmp = `${DB_FILE}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
        await fsp.rename(tmp, DB_FILE);
    });
    return writeChain;
}

function json(res, status, body) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
    const data = Buffer.from(body);
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

async function body(req, maxBytes = 1_000_000) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('request too large');
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}

function sourceDetach(sourceKey) {
    if (!sourceKey) return;
    for (const m of db.memories) {
        if (!Array.isArray(m.sources) || !m.sources.includes(sourceKey)) continue;
        m.sources = m.sources.filter(x => x !== sourceKey);
        if (!m.sources.length && m.origin === 'auto') {
            m.active = false;
            m.deactivatedAt = now();
            m.deactivatedReason = 'source-replaced';
        }
    }
}

function keyMatch(a, b) {
    return a.scopeKey === b.scopeKey
        && normalizeText(a.subject) === normalizeText(b.subject)
        && normalizeText(a.predicate) === normalizeText(b.predicate);
}

function candidateTokens(c) {
    return tokenize([c.summary, c.subject, c.predicate, c.object, ...(c.keywords || [])].join(' '));
}

function mergeMemory(existing, c, sourceKey) {
    existing.summary = c.summary || existing.summary;
    existing.object = c.object || existing.object;
    existing.keywords = [...new Set([...(existing.keywords || []), ...(c.keywords || [])])].slice(0, 16);
    existing.importance = Math.max(existing.importance || 1, c.importance || 1);
    existing.confidence = Math.max(existing.confidence || 0, c.confidence || 0);
    existing.updatedAt = now();
    existing.lastSeenAt = now();
    existing.mentions = (existing.mentions || 1) + 1;
    existing.active = true;
    existing.expiresAt = c.ttlDays ? now() + c.ttlDays * 86400000 : null;
    existing.tokens = candidateTokens(existing);
    existing.sources = [...new Set([...(existing.sources || []), sourceKey].filter(Boolean))].slice(-24);
    return existing;
}

function insertMemory(c, sourceKey) {
    const t = now();
    const m = {
        id: id(),
        scopeKey: c.scopeKey,
        type: c.type || 'fact',
        subject: c.subject || '',
        predicate: c.predicate || '',
        object: c.object || '',
        summary: c.summary || '',
        keywords: Array.isArray(c.keywords) ? c.keywords : [],
        importance: Number(c.importance) || 1,
        confidence: Number(c.confidence) || 0.7,
        mode: c.mode || 'append',
        createdAt: t,
        updatedAt: t,
        lastSeenAt: t,
        expiresAt: c.ttlDays ? t + c.ttlDays * 86400000 : null,
        active: true,
        origin: 'auto',
        sources: sourceKey ? [sourceKey] : [],
        mentions: 1,
        tokens: candidateTokens(c),
    };
    db.memories.push(m);
    return m;
}

function upsertOne(c, sourceKey) {
    if (!c || !c.scopeKey || !c.summary || !c.subject || !c.predicate) return null;

    const sameKey = db.memories.filter(m => m.active !== false && keyMatch(m, c));
    let existing = sameKey.find(m => jaccard(m.object || m.summary, c.object || c.summary) >= 0.72);

    if (!existing) {
        existing = db.memories.find(m =>
            m.active !== false &&
            m.scopeKey === c.scopeKey &&
            jaccard(m.summary, c.summary) >= 0.84
        );
    }

    if (existing) return mergeMemory(existing, c, sourceKey);

    let inserted;
    if (c.mode === 'replace') {
        for (const old of sameKey) {
            old.active = false;
            old.deactivatedAt = now();
            old.deactivatedReason = 'superseded';
        }
        inserted = insertMemory(c, sourceKey);
        for (const old of sameKey) old.supersededBy = inserted.id;
    } else {
        inserted = insertMemory(c, sourceKey);
    }
    return inserted;
}

async function route(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
            ok: true,
            version: VERSION,
            totalCount: db.memories.length,
            activeCount: activeMemories().length,
            dbFile: DB_FILE,
        });
    }

    if (req.method === 'POST' && url.pathname === '/memories/upsert') {
        const payload = await body(req);
        const sourceKey = String(payload.sourceKey || '');
        const candidates = Array.isArray(payload.memories) ? payload.memories.slice(0, 30) : [];

        sourceDetach(sourceKey);
        let changed = 0;
        const touched = [];
        for (const c of candidates) {
            const m = upsertOne(c, sourceKey);
            if (m) { changed++; touched.push(m.id); }
        }
        await persist();
        return json(res, 200, { ok: true, changed, touched, activeCount: activeMemories().length });
    }

    if (req.method === 'POST' && url.pathname === '/memories/search') {
        const payload = await body(req);
        const query = String(payload.query || '');
        const scopes = new Set((payload.scopeKeys || []).map(String));
        const limit = Math.max(1, Math.min(50, Number(payload.limit) || 10));
        const minScore = Math.max(0, Math.min(1, Number(payload.minScore) || 0));
        const memories = activeMemories()
            .filter(m => !scopes.size || scopes.has(m.scopeKey))
            .map(m => {
                const relevance = lexicalScore(query, m);
                return { ...m, score: relevance.score, matched: relevance.matched };
            })
            .filter(m => m.score >= minScore)
            .sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt)
            .slice(0, limit)
            .map(({ tokens, sources, ...m }) => m);

        return json(res, 200, { memories });
    }

    if (req.method === 'POST' && url.pathname === '/memories/list') {
        const payload = await body(req);
        const scopes = new Set((payload.scopeKeys || []).map(String));
        const limit = Math.max(1, Math.min(500, Number(payload.limit) || 100));
        const memories = activeMemories()
            .filter(m => !scopes.size || scopes.has(m.scopeKey))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit)
            .map(({ tokens, sources, ...m }) => m);
        return json(res, 200, { memories });
    }

    if (req.method === 'POST' && url.pathname === '/memories/delete') {
        const payload = await body(req);
        const m = db.memories.find(x => x.id === payload.id);
        if (!m) return json(res, 404, { error: 'memory not found' });
        m.active = false;
        m.deactivatedAt = now();
        m.deactivatedReason = 'manual-delete';
        await persist();
        return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/memories/clear') {
        const payload = await body(req);
        const scopes = new Set((payload.scopeKeys || []).map(String));
        let changed = 0;
        for (const m of db.memories) {
            if (m.active !== false && (!scopes.size || scopes.has(m.scopeKey))) {
                m.active = false;
                m.deactivatedAt = now();
                m.deactivatedReason = 'manual-clear';
                changed++;
            }
        }
        await persist();
        return json(res, 200, { ok: true, changed });
    }

    if (req.method === 'GET' && url.pathname === '/export') {
        return text(
            res,
            200,
            JSON.stringify({ exportedAt: new Date().toISOString(), ...db }, null, 2),
            'application/json; charset=utf-8'
        );
    }

    return json(res, 404, { error: 'not found' });
}

(async () => {
    await loadDb();

    const server = http.createServer((req, res) => {
        route(req, res).catch(err => {
            console.error('[AutoMemory] request error:', err);
            json(res, 500, { error: err.message || String(err) });
        });
    });

    server.listen(PORT, HOST, () => {
        console.log(`[AutoMemory] v${VERSION} listening on http://${HOST}:${PORT}`);
        console.log(`[AutoMemory] database: ${DB_FILE}`);
    });
})();
