# Arquitetura — M5 Agent

Documento de engenharia do `apps/agent`: decisões, contratos, matemática do
modelo, pipeline de dados e critérios de aceite.

## 1. Objetivo

Dado um prompt, o sistema deve:

1. **navegar** no repositório (mapa, índice, símbolos);
2. **ler** os arquivos relevantes;
3. **entender** funcionalidades técnicas (contratos, dependências, testes);
4. **editar** com precisão (patch mínimo, sem reescrever o mundo);
5. **executar** build/teste e **corrigir** o que falhar;
6. **registrar** tudo (transcript, audit, diff) para auditoria.

Isso é um loop de agente com ferramentas — não um chat que "acha" o código.

## 2. O que existia

O repo era uma biblioteca neural didática (`src/`): tensor, dense, CNN,
`TinyGPT` char-level (1 bloco, 1 head, contexto 96, ~1,4 MB de checkpoint),
RAG com `doc-store.json` e CLIs de treino/chat. Não havia loop de agente,
tools, permissões, índice de código nem dataset por linguagem. O `src/index.ts`
inclusive quebrava (`backPropagation is not a function`).

O `TinyGPT` foi mantido como material didático; o M5Coder usa uma pilha nova,
também escrita à mão, mas com BPE, múltiplas camadas/heads e backward correto.

## 3. Camadas

```
┌─────────────────────────────────────────────────────────────┐
│ CLI / API        run · chat · tools · doctor · scope         │
├─────────────────────────────────────────────────────────────┤
│ Agent Loop       contexto → modelo → parse → tools → verify  │
│                  limites, kill switch, sessão, audit         │
├──────────────┬──────────────┬───────────────┬───────────────┤
│ Tools        │ Contexto     │ Modelo        │ Conhecimento  │
│ fs/shell/git │ repo map     │ BPE + GPT     │ CVE/NVD/CWE   │
│ net_probe    │ índice + RAG │ local / HTTP  │ ExploitDB idx │
├──────────────┴──────────────┴───────────────┴───────────────┤
│ Módulos      net (L2/L3) · embedded (USB/protocolos) · seclab│
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Loop (`src/core/loop.ts`)

```
mensagens = [system(tools+repoMap), user(tarefa+trechos)]
até maxSteps/maxToolCalls/deadline/kill-switch:
    resposta = modelo.complete(mensagens)
    chamadas = parse(resposta)          # <tool name="x">{json}</tool>
    se não há chamadas: final = resposta; break
    para cada chamada:
        valida schema → classifica risco → audita → executa
        anexa <tool_result ok="...">…</tool_result>
se arquivos mudaram:
    roda build/teste detectados
    se falhou: injeta o erro e faz 1 rodada de reparo
grava transcript/result/changes/summary
```

### 3.2 Protocolo de tool

O modelo não precisa de function-calling nativo; ele emite:

```xml
<tool name="patch_file">{"path":"src/a.ts","oldString":"x","newString":"y"}</tool>
<final>resumo</final>
```

Aceitamos também `{"tool":"...","input":{...}}` em bloco JSON e `TOOL: nome`.
O parser é tolerante (aspas simples, trailing comma) porque modelos pequenos
erram JSON.

### 3.3 Verificação

`detectVerifyCommands()` reconhece npm/tsc, pytest, cargo, go, maven, gradle,
dotnet, cmake e make. A saída do primeiro erro volta ao modelo como contexto de
reparo. Sem isso, "editar" vira fé.

## 4. Matemática do modelo próprio

### 4.1 Forward

Para tokens `x_t` e posições `t`:

```
h⁰_t = E[x_t] + P[t]
para cada camada l:
    a  = LN(hˡ)                     # LayerNorm
    q,k,v = a·W_qkv                 # [d, 3d]
    para cada head h:
        s_ts = (q_tʰ · k_sʰ)/√(d/H),  s > t → -∞
        α = softmax(s)
        o_tʰ = Σ_s α_ts · v_sʰ
    h̃ = hˡ + concat(o)·W_o          # residual
    u  = GELU(LN(h̃)·W_1)·W_2
    hˡ⁺¹ = h̃ + u
logits = LN(h^L)·Eᵀ                 # weight tying
loss   = -1/T Σ_t log softmax(logits_t)[y_t]
```

Backward é manual para todas as operações (LayerNorm, GELU, softmax causal,
matmuls, embeddings). O teste `backward bate com gradiente numérico` compara
derivadas analíticas com diferenças finitas em 7 tensores.

### 4.2 Contagem de parâmetros

```
N ≈ V·d + ctx·d + L·(4d² + 2·d·d_ff + 4d) + 2d
```

Default deste repo: `V=1536, d=128, L=2, d_ff=320, ctx=128` → **≈ 0,5M params**.

### 4.3 Custo de treino

```
FLOPs ≈ 6 · N · D            (D = tokens)
```

Com o dataset atual (`11.200` amostras, ~700 caracteres de código + instrução e
explicação, ≈ **2,8M tokens**):

- `N=0,5M` → ~8,4×10¹² FLOP ≈ **45 min–2,5 h/epoch** em CPU (JS, 1–3 GFLOP/s efetivos).
- `N=10M` → ~1,7×10¹⁴ FLOP ≈ **16 h–2 dias/epoch** em CPU. Inviável.
- `N=100M` → GPU 24 GB, dias.
- `N=1B` → 8×A100, semanas.
- `N=7B` → pré-treino de cluster; na prática, **LoRA/QLoRA** em 24 GB.

O comando padrão (`--steps 400`, `ctx 128`, batch 1) percorre ~51 mil tokens —
é uma prova de pipeline, não um epoch completo. Para aprendizado real em CPU,
suba `--steps` e `--max-tokens` e aceite horas de execução; para capacidade de
agente, o caminho é GPU ou adapter HTTP.

O carregador de corpus (`src/model/corpus.ts`) faz rodízio entre as 14
linguagens e ignora `all/`. Isso corrige um bug em que `all/train.jsonl` era
tratado como uma linguagem e consumia o limite de 3 MB, treinando apenas
`ts`, `py`, `c`, `cpp` e parte de `sh`. Com o padrão de 3 MB, entram ~240
amostras de cada uma das 14 linguagens.

Conclusão honesta: com 15 GB de RAM e CPU, o caminho é (a) modelo de 0,5–5M
params como prova de pipeline, (b) dataset e runtime perfeitos, (c) GPU ou
fine-tune de modelo aberto quando houver hardware.

### 4.4 Otimizador

AdamW (`β₁=0,9`, `β₂=0,95`, `wd=0,01` só em matrizes), clipping global de
norma 1,0, warmup de 5% e decaimento cosseno até 10% do LR.

## 5. Dataset de código

Schema (`CodeSample`):

```ts
{ id, language, task, instruction, code, explanation, tags, difficulty }
```

Formato de treino (JSONL, um objeto por linha):

```json
{"id":"ts-0001","language":"ts","task":"...","instruction":"...",
 "output":"<code>","explanation":"...","tags":["..."],"difficulty":"basic"}
```

O gerador (`src/datasets/generate.ts`) materializa o produto cartesiano de
cenários × estilos × casos de borda × parâmetros, valida tudo e escreve
`<out>/<lang>/{train,val,test}.jsonl`, `<out>/all/*` e `manifest.json`
(splits 90/5/5 determinísticos por seed).

| Grupo | Linguagens | Meta |
| --- | --- | --- |
| Web | TypeScript/JavaScript, PHP, SQL | 800+ cada |
| Sistemas | C, C++, Rust, Go, x86-64, ARM64 | 800+ cada |
| Back-end | Python, Java, C# | 800+ cada |
| Automação | Bash, PowerShell | 800+ cada |

Qualidade: dedupe por SHA-1 do código, mínimo de 120 chars, checagem de
delimitadores, ausência de placeholders (`TODO`, `...`, `seu código aqui`) e
constructos esperados por linguagem. Splits 90/5/5 determinísticos por seed.

**Limitação declarada:** geração combinatória produz volume e variedade
estrutural, não a densidade de um dataset humano. Para produção, o próximo
passo é curadoria + execução real dos exemplos em sandbox.

## 6. Conhecimento de segurança

- **NVD 2.0** (`services.nvd.nist.gov/rest/json/cves/2.0`): paginação,
  rate limit (6 s sem key), retry/backoff, cache local e retomada.
- Normalização: CVSS 3.1/3.0/2, CWE, CPE → vendor/produto/versão, referências.
- **ExploitDB**: apenas o índice (`files_exploits.csv`) — ID, descrição, data,
  autor, tipo, plataforma, CVEs. **Nenhum corpo de exploit é baixado.**
- Dataset gerado é **defensivo**: explicar, classificar CWE, interpretar CVSS,
  propor mitigação e escrever detecção.
- Fallback offline com 30 CVEs curados (`seed.ts`).

## 7. Modelo de segurança e autonomia

Decisão do produto: `autonomy: "full"` (sem confirmação por chamada).

Controles que continuam ativos **sem** bloquear o fluxo:

| Controle | Efeito |
| --- | --- |
| `allowPatterns` | permite comandos irreversivelmente destrutivos, FRPS exploit ofensivos |
| audit JSONL | toda tool, comando, classificação e escopo |
| sessão | transcript + result + changes + summary por execução |
| kill switch `.m5/STOP` | encerra antes do próximo passo |
| `scope.json` | marca alvo autorizado; sem escopo o log diz "não verificado" |
| seclab `scope.ts` | exige autorização válida e não expirada para recon |
| seclab `audit.ts` | hash chain SHA-256 (detecta adulteração) |

Fora de escopo por decisão técnica e legal: bypass de Knox Guard/FRP/MDM,
modo desenvolvedor sem consentimento, exploit armado, ação contra terceiros.
O módulo embarcado entrega o caminho oficial (Ajustes → Sobre → Número da
versão ×7, ADB somente-leitura sem `authorized`), não o atalho.

## 8. Módulos

### 8.1 Redes (`modules/net`)
IPv4/CIDR (rede, broadcast, hosts, VLSM, sumarização), checksum RFC 1071,
fragmentação/reassembly, switch com aprendizado de MAC/flooding/aging, VLAN
access/trunk 802.1Q, STP (root bridge), rotas com longest-prefix, ARP, TTL,
loop detection e 6 laboratórios com quiz.

### 8.2 Embarcados (`modules/embedded`)
Tabela VID/PID, parser de descritores USB, classes/subclasses, UART/I2C/SPI/CAN
(cálculo de bit timing e erro), Modbus CRC16, MQTT varint, BLE, device tree,
udev/systemd, `pnputil`/COM no Windows e fatos documentados de Knox Guard com
`requiresConsent: true`.

### 8.3 Lab de segurança (`modules/seclab`)
Autorização com validade e escopo, auditoria encadeada, CVSS 3.1 com Roundup
correto, laboratório de stack overflow **local** (vulnerável vs mitigado, com
`checksec` e gdb), checklist de recon e relatório Markdown.

## 9. Verificação e qualidade

- `npm run agent:test` — core, protocolo, tools, loop, modelo, datasets,
  índice, módulos e integração local/HTTP.
- `npm run agent:typecheck` — TS estrito em todo o app.
- Gradiente numérico garante que o backward não está "quase certo".
- Loop testado com modelo roteirizado (determinístico), adapter local com
  checkpoint real e adapter HTTP com `fetch` mockado.

## 10. Roadmap

| Fase | Entrega | Critério de aceite |
| --- | --- | --- |
| 0 (feito) | runtime + tools + política + modelo + dataset + módulos | testes verdes, typecheck limpo |
| 1 (feito) | índice integrado ao loop (`search_code`, `find_symbols`, `repo_map`, `index_build`) | agente acha símbolo sem grep manual |
| 2 | sandbox de execução (container/WSL efêmero) | comando destrutivo não toca o host |
| 3 | dataset curado + execução dos exemplos | ≥ 90% dos exemplos compilam/rodam |
| 4 | treino GPU 100M–1B com o mesmo código | loss de validação monotônica |
| 5 | avaliação SWE-bench-like no repo | ≥ 30% das issues resolvidas |

### Teste de produção

`npm run agent:prodtest` roda typecheck, suíte completa, validação do dataset,
índice (build/busca/repo map/roundtrip), dataset defensivo, módulos e um E2E
real do CLI: servidor OpenAI-compatible local, tool `write_file` executada,
sessão/audit persistidos e checkpoint local carregado. Resultado da última
execução: **9/9 verificações**, 110 testes e typecheck limpos.

Limite explícito: o checkpoint de 509.184 parâmetros (400 steps, val loss 5.54)
carrega e gera tokens, mas a amostra local ainda é incoerente. A infraestrutura
de produção está validada; o modelo próprio só vira agente de código utilizável
com GPU ou destilação de professor, conforme fase 4.

## 11. Decisões registradas (entrevista)

- Modelo: **próprio, do zero** → entregue a pilha completa; escala depende de GPU.
- Hardware: **CPU, 15 GB** → defaults conservadores; treino grande fica documentado.
- MVP: **todos os módulos** → paralelizado e integrado.
- Linguagens: 14 (web, sistemas, back-end, automação).
- Execução: **Windows nativo (PowerShell admin)**.
- Dados: **metadados + PoC pública de fontes oficiais** → implementado como
  metadados + referências; corpo de exploit não é baixado nem gerado.
- Permissões: **autonomia total** → `full`, com audit/kill switch/deny list.
- Local: **novo pacote neste repo** → `apps/agent`.

## 12. Perguntas ainda abertas

1. Qual GPU (se houver) será usada para o treino sério?
2. O dataset sintético será curado manualmente ou por execução em sandbox?
3. O adapter HTTP pode ser usado como "professor" (destilação) do modelo próprio?
4. Qual o alvo de avaliação: repositório próprio, issues reais ou benchmark?
