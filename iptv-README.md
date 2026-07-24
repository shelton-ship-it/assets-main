# iptv-assets

Assets IPTV gerados automaticamente a partir do [iptv-org](https://github.com/iptv-org/iptv).

## Ficheiros gerados

| Ficheiro | Descrição |
|---|---|
| `playlist.m3u` | Todos os canais organizados por categoria |
| `logos.json` | Mapa `{ tvg_id: logo_url }` |

## Actualização

GitHub Actions corre diariamente às **04:00 UTC** e regenera ambos os ficheiros.

Execução manual: Actions → **Update IPTV Assets** → Run workflow.

## Estrutura do repo

```
/
├── playlist.m3u              ← gerado pelo Action
├── logos.json                ← gerado pelo Action
├── .github/
│   └── workflows/
│       └── update.yml        ← cron diário
└── scripts/
    ├── package.json
    └── generate.js           ← script principal
```

## Setup inicial

1. Criar o repo como **privado**
2. Correr o workflow manualmente para gerar os ficheiros pela primeira vez
3. Gerar um GitHub PAT com scope `repo` (read) e adicionar como `GITHUB_ASSETS_TOKEN` no EdgeOne

## Variável de ambiente necessária no EdgeOne

```
GITHUB_ASSETS_TOKEN = ghp_xxxxxxxxxxxx
```
