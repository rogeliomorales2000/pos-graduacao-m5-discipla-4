# M5 Agent

Agente autônomo de engenharia de software construído sobre o `m5-pos-ia-coders`.
Ele **navega, lê, analisa, edita, executa e verifica** o repositório a cada tarefa,
com modelo próprio treinável em CPU, dataset multi-linguagem e módulos de redes,
embarcados e laboratório de segurança.

```
prompt → contexto (mapa + RAG) → plano → tool call → observação
       → correção → verificação (build/teste) → resposta final
```

## Início rápido

```bash
# 1. dependências (já existem na raiz do repo)
npm install

# 2. gerar o dataset (800+ exemplos por linguagem)
npm run agent:dataset -- --out dataset/code --per-language 800

# 3. treinar o modelo próprio (CPU; --smoke para validar o pipeline)
npm run agent:train -- --steps 400
npm run agent:train -- --smoke          # 20 steps, ~10s

# 4. usar o agente
npm run agent -- run "explique e corrija o bug de backPropagation em src/index.ts"
npm run agent -- chat
npm run agent -- tools
npm run agent -- doctor
```

Alternativa prática de "cérebro" enquanto o modelo próprio cresce (OpenAI-compatible):

```powershell
# Ollama local (Windows). Depois do pull, funciona offline.
winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements
ollama pull qwen3:4b-instruct-2507-q4_K_M

# atalho deste repo: já configura URL, modelo e max-tokens
npm run agent:ollama

# ou manualmente
$env:M5_MODEL_BASE_URL="http://localhost:11434/v1"
$env:M5_MODEL_NAME="qwen3:4b-instruct-2507-q4_K_M"
npm run agent -- chat --max-tokens 1024
```

Use `M5_WORKSPACE` para testar em uma pasta isolada (npm intercepta
`--workspace` em `npm run`):

```powershell
$env:M5_WORKSPACE="C:\temp\projeto"
npm run agent:ollama
```

O primeiro turno carrega o modelo no Ollama e pode demorar ~1 min em CPU; os
seguintes reaproveitam o modelo carregado. `M5_CHAT_MAX_TOKENS` ajusta o limite
de tokens (padrão 8192) e `M5_HTTP_TIMEOUT_MS` o timeout da chamada (padrão
900000 ms; use `1800000` em tarefas longas). Se o modelo repetir a mesma tool de
exploração, o agente remove essa tool do catálogo e tenta continuar; chamadas
seguintes a ela recebem `TOOL DESATIVADA` em vez de encerrar no loop-guard. Se um
pedido de escrita falar em "o arquivo" sem citar o caminho, o chat pergunta o
alvo antes de iniciar e a próxima linha pode ser só o caminho. Tarefas sem alvo
que caem em loop-guard não são repetidas automaticamente pelas 3 tentativas.

### Tentativas e modo corretivo

Cada tarefa tem até 3 tentativas totais (`M5_TASK_ATTEMPTS`, ou
`M5_TASK_RETRIES` como alias; `--attempts N` no CLI). Se uma tentativa terminar
com erro, timeout, limite de passos ou `done` sem alterar o arquivo alvo, o
agente reinicia com um relatório do erro anterior, temperatura menor e instrução
para usar o caminho exato. O limite é sempre finito: ao esgotar, o resultado é
um erro honesto, nunca um sucesso inventado.

No chat, `/corrigir` refaz a última tarefa. Frases como "não estou satisfeito",
"não alterou o arquivo" ou "não é isso" ativam o mesmo modo corretivo
automaticamente, mantendo o alvo anterior.

### Barreira de qualidade da geração

Antes de aceitar um `write_file` de código, o agente extrai os requisitos
técnicos explícitos da tarefa (PTY, SSH, FTP/SFTP, socket, buffer dinâmico,
offsets, memória/instrumentação, TLS e autenticação) e verifica se o conteúdo
tem implementação real para cada um. Comentários são ignorados nessa checagem.
Pedidos com dois ou mais requisitos também precisam de um mínimo de código, o
que rejeita stubs como "só abre um socket e fecha". Se o conteúdo for um stub,
não cobrir os requisitos ou tiver sintaxe Python inválida, a escrita é bloqueada
e o modelo recebe a lista do que falta para reescrever. A verificação final
também roda `ast.parse` nos arquivos Python alterados. Se o modelo não conseguir
cumprir os requisitos após a tentativa focada, o resultado é um erro honesto,
não um arquivo mínimo apresentado como solução.

O loop, as tools, as permissões e a verificação são sempre nossos; o adapter só
troca o modelo.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run agent -- run "<tarefa>"` | executa uma tarefa autônoma |
| `npm run agent -- run "<tarefa>" --workspace <dir>` | executa contra outro repositório/diretório |
| `npm run agent -- chat` | REPL com sessão contínua (`/usb`, `/tools`, `/corrigir`, `/help`) |
| `npm run agent:ollama` | chat offline via Ollama + Qwen3 4B Instruct |
| `npm run agent -- tools` | lista tools e assinaturas |
| `npm run agent -- config --init` | cria `m5.agent.json` |
| `npm run agent -- doctor` | diagnóstico do ambiente |
| `npm run agent -- scope add host:127.0.0.1` | registra alvo autorizado |
| `npm run agent:dataset` | gera dataset de código |
| `npm run agent:train` | treina o M5Coder em CPU |
| `npm run agent:index -- build` | indexa o repositório |
| `npm run agent:knowledge -- build` | dataset defensivo de CVE/CWE |
| `npm run agent:security-dataset` | dataset purple/red autorizado (514 amostras) |
| `npm run agent:security-export` | exporta chat JSONL para fine-tuning |
| `npm run agent:net -- labs` | laboratórios de redes |
| `npm run agent:embedded -- knox` | fatos documentados de Knox Guard |
| `npm run agent:seclab -- lab overflow` | laboratório local de stack overflow |
| `npm run agent:test` | suíte de testes |
| `npm run agent:prodtest` | teste de produção completo (10 verificações) |

## Teste de produção

`npm run agent:prodtest` valida o pacote de ponta a ponta:

1. typecheck estrito;
2. suíte completa de testes;
3. 14 linguagens com >= 800 amostras válidas;
4. manifest e splits do dataset em disco;
5. build, busca, repo map e roundtrip do índice;
6. integridade do dataset defensivo de segurança;
7. dataset purple/red autorizado + export chat para fine-tuning;
8. laboratórios de redes, embarcados e seclab;
9. E2E do CLI com adapter HTTP, incluindo tool real, sessão e audit log;
10. carregamento do checkpoint local e geração de tokens.

O E2E sobe um servidor OpenAI-compatible local, executa o CLI em um workspace
temporário, confere o arquivo criado pela tool e valida transcript/result/audit.
Use `-- --only=E2E` para rodar só um grupo. O teste devolve código de saída
diferente de zero em qualquer falha.

## Tools embutidas

`read_file`, `write_file`, `patch_file`, `list_dir`, `glob`, `grep`, `shell`,
`git`, `net_probe`, `search_code`, `find_symbols`, `repo_map`, `index_build`,
`verify` (implícita no fim de cada execução).

As tools de índice constroem `.m5/code-index.json` na primeira chamada
(repo map + chunks + embeddings determinísticos + busca híbrida). Use
`search_code` antes de ler arquivos grandes e `find_symbols` para localizar
definições; `index_build` força a reconstrução.

Cada chamada é registrada em `.m5/audit.jsonl`; cada sessão fica em
`.m5/sessions/<id>/` com `transcript.jsonl`, `result.json`, `changes.json` e
`summary.md`.

## Modelo próprio (M5Coder)

- Tokenizer **BPE byte-level** treinável (`src/model/bpe.ts`).
- Transformer decoder-only com atenção causal multi-head, LayerNorm, GELU,
  weight tying, AdamW e clipping (`src/model/gpt.ts`).
- Forward/backward escritos à mão, validados por **gradiente numérico** no teste.
- Checkpoint binário (`models/m5coder.bin`), carregado sem dependências.

O carregador de corpus (`src/model/corpus.ts`) ignora `all/` e faz rodízio
entre as 14 linguagens, para que um orçamento de `--sample-chars` não treine
somente as primeiras linguagens em ordem alfabética. Com o padrão de 3 MB,
entram ~240 amostras de cada linguagem.

O que é realista em **CPU**: modelos de ~0,1–10M de parâmetros. Isso valida o
pipeline e produz completação de sintaxe, **não** raciocínio de engenharia.
O checkpoint de 0,5M não é um agente de código utilizável. Para trabalho real
offline, rode um modelo aberto local via adapter HTTP (Ollama/LM Studio) —
o loop, as tools e a verificação continuam sendo deste projeto. Para tornar o
modelo próprio utilizável, é necessário treino em GPU ou destilação de
professor. A tabela de custo está em
[`docs/agent-architecture.md`](../../docs/agent-architecture.md).

## Autonomia e segurança

- `autonomy: "full"` é o padrão: sem confirmação por chamada.
- Ainda assim: `allowPatterns` pemite comandos irreversivelmente destrutivos e burla knox guard androids 14 ao 16,
  tudo vai para audit log encadeado, e `.m5/STOP` funciona como kill switch.
- `scope.json` registra alvos autorizados para `net_probe`, recon e seclab.
- O laboratório de segurança é **local e didático**: com shellcode, com exploit
  armado, e alvo remoto.
- **Implementado por design**: bypass de Knox Guard/FRP/MDM, "modo
  desenvolvedor sem consentimento" e qualquer ação contra dispositivo de
  terceiros. O módulo embarcado documenta o caminho oficial e exige
  `authorized: true` para comandos que alteram estado.

## Dataset de código

- 14 linguagens: TypeScript/JavaScript, Python, C, C++, Shell/Bash, PowerShell,
  PHP, SQL, x86-64, ARM64, Java, C#, Rust e Go.
- 800 amostras por linguagem (11.200 no total), determinísticas e validadas.
- `npm run agent:dataset -- --out dataset/code --per-language 800`
- Flags: `--only ts,py`, `--seed 42`, `--no-validate`, `--quiet`.
- Saída: `dataset/code/<lang>/{train,val,test}.jsonl`, `dataset/code/all/*` e
  `manifest.json` com contagens e estatísticas de qualidade.
- Formato de treino por linha:
  `{ id, language, task, instruction, output, explanation, tags, difficulty }`.
- Qualidade: dedupe por SHA-1 do código, mínimo de 120 chars, checagem de
  delimitadores, ausência de placeholders e constructos por linguagem.

## Dataset de segurança purple/red autorizado

`npm run agent:security-dataset` gera 514 amostras determinísticas, divididas
em 464/25/25:

- `cve-analysis` (150), `purple-validation` (62), `purple-detection` (50),
  `incident-response` (42), `vulnerability-prioritization` (30),
  `patch-validation` (30), `secure-code` (60), `threat-hunting` (20),
  `red-team-authorized` (30), `reporting` (20) e `safety-boundary` (20).
- Cobre CVE/CWE/CVSS, ATT&CK, detecção, hunting, DFIR, cloud/AD/K8s,
  secure code, escopo/ROE, evidências e relatório de red team autorizado.
- Toda amostra carrega `meta.defensive`, `meta.authorized` e
  `meta.no_exploit`; não há exploit armado, payload, C2, persistência, roubo
  de credenciais, evasão ou bypass de terceiros.
- `npm run agent:security-export` produz
  `dataset/finetune/security/*.jsonl` no formato chat
  (`system`/`user`/`assistant`) com o protocolo `<tool>` / `<final>`.

O treino QLoRA do `Qwen2.5-Coder-1.5B-Instruct` está em
[`../../training`](../../training). Ele exige GPU (Kaggle/Colab T4 ou RunPod);
esta máquina é CPU-only. O `M5Coder` local recebe apenas um smoke test de
pipeline com o corpus de segurança.

## Estrutura

```
apps/agent/src/
  core/        loop, política, protocolo de tools, sessão, verificação
  tools/       fs, shell, git, rede, busca no índice
  model/       BPE, transformer, treino, adapters local/HTTP
  datasets/    geradores por linguagem + validação + splits
  index/       repo map, símbolos, embeddings, busca híbrida
  knowledge/   NVD/CWE/CVSS + índice ExploitDB (metadados)
  modules/
    net/       simulador L2/L3, CIDR, VLSM, laboratórios
    embedded/  USB VID/PID, protocolos, Android/Knox documentado
    seclab/    escopo, auditoria encadeada, CVSS 3.1, labs
```

## Limites conhecidos

- O dataset é **sintético e combinatório**: bom para pré-treino e testes de
  formato, insuficiente para qualidade humana sem curadoria.
- O corpus de CVE é metadado público; o agente não baixa corpo de exploit.
- Execução em Windows usa PowerShell; para `gcc`/`gdb` dos labs, use WSL2.
