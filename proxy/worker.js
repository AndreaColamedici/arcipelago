// Cloudflare Worker — proxy API + counter visite per Arcipelago
// Deploy: npx wrangler deploy
// Secrets: npx wrangler secret put ANTHROPIC_API_KEY
//          npx wrangler secret put STATS_TOKEN
// KV:     npx wrangler kv:namespace create VISITS
//         (poi copia l'id nel wrangler.toml)

const ALLOWED_ORIGIN = 'https://andreacolamedici.github.io';
const ALLOWED_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_LIMIT = 400;

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: { ...corsHeaders(origin), 'Access-Control-Max-Age': '86400' }
            });
        }

        // --- COUNTER VISITE ---
        if (url.pathname === '/count') {
            return handleCount(request, env, origin);
        }

        // --- STATS (protetto da token) ---
        if (url.pathname === '/stats') {
            return handleStats(request, env, url);
        }

        // --- PROXY API ANTHROPIC ---
        return handleProxy(request, env, origin);
    }
};

async function handleCount(request, env, origin) {
    if (request.method !== 'POST') {
        return new Response('', { status: 204 });
    }

    try {
        const body = await request.json();
        const page = String(body.p || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 50);
        const oggi = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

        // Incrementa contatore totale per pagina
        const keyTot = `tot:${page}`;
        const tot = parseInt(await env.VISITS.get(keyTot) || '0') + 1;
        await env.VISITS.put(keyTot, String(tot));

        // Incrementa contatore giornaliero
        const keyDay = `day:${oggi}:${page}`;
        const day = parseInt(await env.VISITS.get(keyDay) || '0') + 1;
        await env.VISITS.put(keyDay, String(day), { expirationTtl: 90 * 86400 });

        // Contatore globale giornaliero
        const keyGlob = `day:${oggi}:_total`;
        const glob = parseInt(await env.VISITS.get(keyGlob) || '0') + 1;
        await env.VISITS.put(keyGlob, String(glob), { expirationTtl: 90 * 86400 });

        return new Response('', {
            status: 204,
            headers: corsHeaders(origin)
        });
    } catch {
        return new Response('', { status: 204 });
    }
}

async function handleStats(request, env, url) {
    const token = url.searchParams.get('token');
    if (!token || token !== env.STATS_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const result = { totali: {}, oggi: {}, ultimi_giorni: {} };
    const oggi = new Date().toISOString().slice(0, 10);

    // Lista tutte le chiavi (max 1000, sufficiente)
    const allKeys = await env.VISITS.list({ limit: 1000 });

    for (const key of allKeys.keys) {
        const val = await env.VISITS.get(key.name);
        if (key.name.startsWith('tot:')) {
            result.totali[key.name.replace('tot:', '')] = parseInt(val);
        } else if (key.name.startsWith(`day:${oggi}:`)) {
            result.oggi[key.name.replace(`day:${oggi}:`, '')] = parseInt(val);
        } else if (key.name.startsWith('day:')) {
            const parts = key.name.split(':');
            const data = parts[1];
            const pagina = parts.slice(2).join(':');
            if (!result.ultimi_giorni[data]) result.ultimi_giorni[data] = {};
            result.ultimi_giorni[data][pagina] = parseInt(val);
        }
    }

    return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleProxy(request, env, origin) {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (origin !== ALLOWED_ORIGIN) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    body.model = ALLOWED_MODEL;
    if (!body.max_tokens || body.max_tokens > MAX_TOKENS_LIMIT) {
        body.max_tokens = MAX_TOKENS_LIMIT;
    }
    if (body.messages && body.messages.length > 20) {
        body.messages = body.messages.slice(-20);
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        const data = await response.text();
        return new Response(data, {
            status: response.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            }
        });
    } catch {
        return new Response(JSON.stringify({ error: 'Upstream error' }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            }
        });
    }
}
