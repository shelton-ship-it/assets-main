// scripts/generate.js
// ─────────────────────────────────────────────────────────────────────────────
// Busca todos os canais do iptv-org via API JSON (fonte canónica actual).
// Gera:
//   ../playlist.m3u  — playlist M3U completa com todos os canais
//   ../logos.json    — mapa { tvg_id: logo_url } para lookup rápido
//
// Fonte: https://github.com/iptv-org/iptv
//   canais + metadados: https://iptv-org.github.io/api/channels.json
//   logos:               https://iptv-org.github.io/api/logos.json
//   streams activos:     https://iptv-org.github.io/api/streams.json
//
// NOTA (2026-07): a API da iptv-org mudou desde a última versão deste script:
//   1. channels.json deixou de ter o campo "logo" — os logos agora vivem
//      num endpoint próprio (logos.json), indexado por channel+feed.
//   2. streams.json passou a devolver "channel": null na maioria das
//      entradas (o vínculo stream → canal deixou de ser garantido). Cada
//      stream continua a trazer "title" com o nome legível — é o fallback
//      obrigatório quando não há "channel" para casar com channels.json.
// Ambas as mudanças quebravam thumbs/logos e nomes ("Unknown" em tudo).
//
// NOTA (2026-08): streams.json pode trazer o MESMO canal várias vezes
// (fontes/mirrors diferentes para o mesmo nome). O filtro de playability
// (HTTPS+CORS) não resolve isso — só garante que o stream individual abre.
// Por isso, depois de filtrar por playability, há um passo extra de dedup
// por NOME (dedupeByName): garante que só entra um canal por nome no
// playlist.m3u final, escolhendo o melhor candidato entre os duplicados.
//
// NOTA: index.category.m3u foi descontinuado pelo iptv-org — usar API JSON.
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const CHANNELS_API = 'https://iptv-org.github.io/api/channels.json';
const STREAMS_API  = 'https://iptv-org.github.io/api/streams.json';
const LOGOS_API    = 'https://iptv-org.github.io/api/logos.json';
const TIMEOUT_MS   = 60_000; // ficheiros grandes — 60s

// ── Fetch com timeout e retry ─────────────────────────────────────────────────
async function fetchJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            return JSON.parse(text);
        } catch (err) {
            clearTimeout(timer);
            if (i === retries - 1) throw err;
            const wait = 3000 * (i + 1);
            console.warn(`  ↳ retry ${i + 1}/${retries} for ${url} (${err.message}) — waiting ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
}

// ── Escolhe o melhor logo para um channel_id a partir de logos.json ───────────
// Cada canal pode ter vários logos (por feed / tag). Preferência:
//   1. feed === null (logo "genérico" do canal, não de um feed regional específico)
//   2. in_use === true
//   3. o primeiro que aparecer, como último recurso
function pickBestLogo(apiLogos) {
    const bestByChannel = {}; // channel_id -> { score, url }

    for (const logo of apiLogos) {
        if (!logo.channel || !logo.url) continue;

        let score = 0;
        if (logo.feed === null) score += 2;
        if (logo.in_use)        score += 1;

        const current = bestByChannel[logo.channel];
        if (!current || score > current.score) {
            bestByChannel[logo.channel] = { score, url: logo.url };
        }
    }

    const logoMap = {};
    for (const [channelId, { url }] of Object.entries(bestByChannel)) {
        logoMap[channelId] = url;
    }
    return logoMap;
}

// ── Health-check: HTTPS + CORS ────────────────────────────────────────────────
// Técnica real usada por agregadores como o TV Garden: eles não fazem proxy
// de stream nenhum — só mostram canais cuja origem já cumpre os requisitos
// que o browser exige (HTTPS válido + cabeçalho CORS presente). Fazemos essa
// verificação aqui, uma vez por execução do workflow (não por viewer, não em
// tempo real) e cortamos da playlist quem não passa. Isto corre inteiramente
// dentro do GitHub Actions — sem servidor próprio a servir segmentos.
//
// Um canal só entra no playlist.m3u se:
//   1. for https:// (http:// dá sempre mixed-content numa página https)
//   2. a resposta trouxer Access-Control-Allow-Origin (sem isso, hls.js/
//      fetch do browser bloqueia sempre, independentemente do resto)
//   3. o certificado TLS for válido (fetch nativo do Node já rejeita
//      certificados inválidos por padrão — um throw aqui já filtra isso)

const HEALTHCHECK_TIMEOUT_MS = 8_000;
const HEALTHCHECK_CONCURRENCY = 25; // paralelismo — ajusta conforme o tempo de execução do workflow

// ── Origens de produção a simular ─────────────────────────────────────────────
// O browser SEMPRE envia "Origin" num pedido cross-origin; o fetch do Node NÃO
// envia por padrão. Se o servidor do stream decide o CORS por reflexão de
// Origin (só devolve ACAO quando reconhece o domínio, ou devolve um valor
// diferente consoante quem pergunta), testar sem Origin dá um resultado que
// não bate certo com o que o browser real vai ver. Aqui simulamos os domínios
// onde o player efectivamente corre — ajusta esta lista se mudar.
const PRODUCTION_ORIGINS = [
    'https://www.pixgo.frii.site',
    'https://pixgo.frii.site',
    'https://pixgo.qzz.io',
];

// User-Agent de um browser real — alguns CDNs também decidem CORS/bloqueiam
// consoante o UA parecer bot ou não, independentemente do Origin enviado.
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Um canal só é considerado "playable in browser" — limpo, sem ruído — se
// TODAS as origens de produção receberem CORS válido. Basta falhar numa
// origem para o canal ser excluído: o objectivo é zero falsos positivos, não
// "funciona nalgum domínio". Isto NÃO garante 100% de paridade com o browser
// real: fingerprinting de TLS/HTTP2 (JA3/JA4) do Node é estruturalmente
// diferente do Chrome e nenhum header consegue mascarar isso, e o alvo por
// trás de shorteners/CDNs pode rodar entre esta verificação e o play do
// utilizador (drift temporal — reduz-se correndo o workflow mais vezes, não
// se elimina).
async function isPlayableInBrowser(url) {
    if (!url.startsWith('https://')) return false; // mixed content — descarta já sem gastar request

    for (const origin of PRODUCTION_ORIGINS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

        try {
            const resp = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Origin': origin,
                    'Referer': origin + '/',
                },
            });
            clearTimeout(timer);

            const acao = resp.headers.get('access-control-allow-origin');
            const allowed = acao === '*' || acao === origin;

            // Falhou nesta origem → falha para o canal inteiro, corta já.
            if (!allowed || (!resp.ok && resp.status !== 206)) return false;

        } catch {
            clearTimeout(timer);
            // timeout, DNS falhou, TLS inválido, connection refused — também
            // conta como falha nesta origem, corta já.
            return false;
        }
    }

    return true; // passou em TODAS as origens de produção
}

// Corre isPlayableInBrowser sobre uma lista, com paralelismo limitado, para
// não abrir milhares de conexões simultâneas nem estourar o runner do Actions.
async function filterPlayable(items, getUrl) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await isPlayableInBrowser(getUrl(items[i]));
        }
    }

    const workers = Array.from({ length: HEALTHCHECK_CONCURRENCY }, worker);
    await Promise.all(workers);

    return items.filter((_, i) => results[i]);
}

// ── Dedup por NOME de canal ───────────────────────────────────────────────────
// Depois do filtro de playability, streams.json ainda pode conter o mesmo
// canal várias vezes (fontes/mirrors distintos, mesmo nome). Aqui reduzimos
// a um único stream por nome, escolhendo o melhor candidato quando há mais
// que um:
//   1. tem "channel" id (veio de channels.json — metadados mais fiáveis que
//      o "title" cru de streams.json)
//   2. tem logo associado (via logoMap, também depende de "channel")
//   3. o primeiro que aparecer, como último recurso
//
// A chave de agrupamento é o mesmo "name" que acaba escrito no #EXTINF
// (meta.name || stream.title || 'Unknown'), normalizado (trim + lowercase)
// para não deixar passar duplicados por diferença de maiúsculas/espaços.
function dedupeByName(items, channelMeta, logoMap) {
    const bestByName = {}; // normalizedName -> { score, item }

    for (const item of items) {
        const meta = item.channel ? (channelMeta[item.channel] || {}) : {};
        const name = meta.name || item.title || 'Unknown';
        const key  = name.trim().toLowerCase();
        if (!key) continue;

        let score = 0;
        if (item.channel) score += 2;
        if (item.channel && logoMap[item.channel]) score += 1;

        const current = bestByName[key];
        if (!current || score > current.score) {
            bestByName[key] = { score, item };
        }
    }

    return Object.values(bestByName).map(({ item }) => item);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== IPTV Assets Generator ===');
    console.log(`Started at ${new Date().toISOString()}`);

    // 1. Buscar metadados dos canais (categorias, nomes, país)
    console.log('\n[1/5] Fetching channels metadata...');
    const apiChannels = await fetchJson(CHANNELS_API);
    console.log(`  ✓ ${apiChannels.length} channels`);

    const channelMeta = {};
    for (const ch of apiChannels) {
        if (!ch.id) continue;
        channelMeta[ch.id] = ch;
    }

    // 2. Buscar logos (endpoint próprio — channels.json não tem mais "logo")
    console.log('\n[2/5] Fetching logos...');
    const apiLogos = await fetchJson(LOGOS_API);
    const logoMap  = pickBestLogo(apiLogos);
    console.log(`  ✓ ${apiLogos.length} logo entries → ${Object.keys(logoMap).length} channels with a logo`);

    // 3. Buscar streams activos
    console.log('\n[3/5] Fetching active streams...');
    const streams = await fetchJson(STREAMS_API);
    console.log(`  ✓ ${streams.length} streams`);

    const withChannelId = streams.filter(s => s.channel).length;
    console.log(`  ↳ ${withChannelId}/${streams.length} streams have a "channel" id (rest fall back to "title")`);

    // 4. Filtrar por playability (HTTPS + CORS)
    console.log('\n[4/6] Checking HTTPS + CORS playability...');

    const seenUrls = new Set();
    const dedupedStreams = streams.filter(s => {
        if (!s.url || seenUrls.has(s.url)) return false;
        seenUrls.add(s.url);
        return true;
    });
    console.log(`  ↳ ${dedupedStreams.length} unique stream URLs to check`);

    const playableStreams = await filterPlayable(dedupedStreams, s => s.url);
    console.log(`  ✓ ${playableStreams.length}/${dedupedStreams.length} playable direto no browser (resto excluído do playlist)`);

    // 5. Dedup por nome — nunca mais de um canal com o mesmo nome no playlist final
    console.log('\n[5/6] Deduping by channel name...');
    const uniqueByName = dedupeByName(playableStreams, channelMeta, logoMap);
    console.log(`  ✓ ${uniqueByName.length}/${playableStreams.length} canais únicos por nome (${playableStreams.length - uniqueByName.length} duplicados removidos)`);

    console.log('\n[6/6] Writing output files...');

    const m3uLines = ['#EXTM3U'];

    let added = 0;
    for (const stream of uniqueByName) {
        const url = stream.url;

        const meta  = stream.channel ? (channelMeta[stream.channel] || {}) : {};
        const tvgId = stream.channel || '';

        // "channel" vem null com frequência agora — usar o "title" do stream
        // como nome antes de cair em "Unknown".
        const name     = meta.name || stream.title || 'Unknown';
        const logo     = (tvgId && logoMap[tvgId]) || '';
        const group    = (meta.categories && meta.categories[0]) || 'Other';
        const language = (meta.languages && meta.languages[0]) || '';
        const country  = meta.country || '';

        const attrs = [
            `tvg-id="${tvgId}"`,
            `tvg-name="${name.replace(/"/g, '')}"`,
            logo ? `tvg-logo="${logo}"` : '',
            `group-title="${group}"`,
            language ? `tvg-language="${language}"` : '',
            country  ? `tvg-country="${country}"`  : '',
        ].filter(Boolean).join(' ');

        m3uLines.push(`#EXTINF:-1 ${attrs},${name}`);
        m3uLines.push(url);
        added++;
    }

    console.log(`  ✓ ${added} unique streams`);

    const m3uContent = m3uLines.join('\n') + '\n';
    writeFileSync(resolve(ROOT, 'playlist.m3u'), m3uContent, 'utf8');
    console.log(`  ✓ playlist.m3u written (${(m3uContent.length / 1024 / 1024).toFixed(2)} MB)`);

    writeFileSync(resolve(ROOT, 'logos.json'), JSON.stringify(logoMap, null, 0), 'utf8');
    console.log(`  ✓ logos.json written (${Object.keys(logoMap).length} entries)`);

    console.log(`\nDone at ${new Date().toISOString()}`);
}

main().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
