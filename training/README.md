# Fine-tuning de segurança (purple/red autorizado)

Este diretório contém o caminho de QLoRA para transformar o
`Qwen2.5-Coder-1.5B-Instruct` em um agente melhor em segurança **defensiva**,
**purple team** e **red team autorizado**.

O dataset não contém exploit armado, payload, C2, persistência, roubo de
credenciais, evasão ou bypass de terceiros. O foco é:

- análise de CVE/CWE/CVSS;
- detecção, threat hunting e validação purple team;
- resposta a incidentes e DFIR;
- priorização e validação de patch;
- secure code e revisão de falhas;
- planejamento, escopo, evidências e relatório de red team autorizado;
- recusa segura quando o pedido sai do escopo.

## 1. Gerar e validar localmente (CPU)

Na raiz do repositório:

```powershell
npm run agent:security-dataset
npm run agent:security-export
npm run agent:test
```

Saídas:

```text
dataset/security-tune/{train,validation,test}.jsonl
dataset/security-tune/own/security/{train,validation,test}.jsonl
dataset/security-tune/manifest.json

dataset/finetune/security/{train,validation,test}.jsonl
dataset/finetune/security/manifest.json
```

O diretório `own/security` serve para um smoke test do modelo próprio
`M5Coder`, que é pequeno e CPU-only. Ele valida o pipeline, não produz um
agente de segurança utilizável.

## 2. Smoke test do modelo próprio (opcional, CPU)

```powershell
npm run agent:train -- --data dataset/security-tune/own --steps 20 --out models/security-smoke.bin
```

Use apenas para confirmar que o corpus é carregado. Não sobrescreva
`models/m5coder.bin` sem necessidade.

## 3. QLoRA em GPU (Kaggle/Colab T4, RunPod etc.)

Requisitos: GPU com 16 GB VRAM, Python 3.10/3.11 e CUDA.

```bash
pip install -r training/requirements.txt

python training/qlora_security.py \
  --train dataset/finetune/security/train.jsonl \
  --validation dataset/finetune/security/validation.jsonl \
  --output outputs/qwen-security-lora \
  --merge outputs/qwen-security-merged \
  --gguf outputs/qwen-security-gguf
```

Smoke test rápido na GPU (10 passos):

```bash
python training/qlora_security.py \
  --smoke \
  --train dataset/finetune/security/train.jsonl \
  --validation dataset/finetune/security/validation.jsonl \
  --output outputs/qwen-security-smoke
```

Se estiver sem GPU, o script para com uma mensagem clara. `--allow-cpu` é
experimental e muito lento; não é o caminho recomendado.

## 4. Importar no Ollama

Depois de baixar o GGUF:

```powershell
ollama create m5-security -f training/Modelfile.example
$env:M5_MODEL_NAME="m5-security"
npm run agent:ollama
```

Ajuste o `FROM` em `training/Modelfile.example` para o caminho real do
arquivo `*.gguf`.

## 5. Avaliação

Use o split `test` para comparar o modelo ajustado com o baseline. Métricas
práticas:

- formato correto do protocolo `<tool>` / `<final>`;
- qualidade e groundedness das referências CVE/CWE;
- recusa correta em pedidos inseguros;
- cobertura de detecção e resposta;
- ausência de alucinação de ferramenta ou resultado;
- relatório com dono, prazo e critério de aceite.

## 6. Limitações

- O dataset é pequeno para "red team raiz". Ele ensina estrutura, escopo,
  detecção e relatório; não substitui experiência de campo.
- Para melhorar de verdade, adicione traces reais e anonimizados de laboratório
  autorizado, resultados de exercícios purple team e relatórios internos.
- Um modelo 1.5B ajustado não vira um especialista de 7B/14B. O ganho principal
  é formato, método, segurança de escopo e consistência.
- Não use este material contra terceiros sem autorização escrita.
