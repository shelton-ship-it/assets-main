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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== IPTV Assets Generator ===');
    console.log(`Started at ${new Date().toISOString()}`);

    // 1. Buscar metadados dos canais (categorias, nomes, país)
    console.log('\n[1/4] Fetching channels metadata...');
    const apiChannels = await fetchJson(CHANNELS_API);
    console.log(`  ✓ ${apiChannels.length} channels`);

    const channelMeta = {};
    for (const ch of apiChannels) {
        if (!ch.id) continue;
        channelMeta[ch.id] = ch;
    }

    // 2. Buscar logos (endpoint próprio — channels.json não tem mais "logo")
    console.log('\n[2/4] Fetching logos...');
    const apiLogos = await fetchJson(LOGOS_API);
    const logoMap  = pickBestLogo(apiLogos);
    console.log(`  ✓ ${apiLogos.length} logo entries → ${Object.keys(logoMap).length} channels with a logo`);

    // 3. Buscar streams activos
    console.log('\n[3/4] Fetching active streams...');
    const streams = await fetchJson(STREAMS_API);
    console.log(`  ✓ ${streams.length} streams`);

    const withChannelId = streams.filter(s => s.channel).length;
    console.log(`  ↳ ${withChannelId}/${streams.length} streams have a "channel" id (rest fall back to "title")`);

    // 4. Gerar playlist.m3u
    console.log('\n[4/4] Writing output files...');

    const m3uLines = ['#EXTM3U'];
    const seen     = new Set(); // dedup por url

    let added = 0;
    for (const stream of streams) {
        const url = stream.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);

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
