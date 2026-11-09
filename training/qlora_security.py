#!/usr/bin/env python3
"""
QLoRA do M5 Security Agent sobre Qwen2.5-Coder-1.5B-Instruct.

Este script foi desenhado para GPU (Kaggle/Colab T4, RunPod ou similar).
Ele NÃO é executado no treino local do modelo próprio (M5Coder), que é CPU-only.

Escopo do dataset: defesa, purple team, red team autorizado, DFIR, detecção,
secure code e limites de segurança. Não há exploit armado, payload, C2,
persistência, roubo de credenciais ou bypass de terceiros.

Uso típico:
  python training/qlora_security.py \
    --train dataset/finetune/security/train.jsonl \
    --validation dataset/finetune/security/validation.jsonl \
    --output outputs/qwen-security-lora \
    --merge outputs/qwen-security-merged \
    --gguf outputs/qwen-security-gguf

Smoke test (poucos passos, apenas para validar o pipeline):
  python training/qlora_security.py --smoke --output outputs/qwen-security-smoke
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="QLoRA defensivo/purple/red autorizado")
    parser.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    parser.add_argument("--train", default="dataset/finetune/security/train.jsonl")
    parser.add_argument("--validation", default="dataset/finetune/security/validation.jsonl")
    parser.add_argument("--output", default="outputs/qwen-security-lora")
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--smoke", action="store_true", help="10 passos para validar o pipeline")
    parser.add_argument(
        "--allow-cpu",
        action="store_true",
        help="Experimental e muito lento; use apenas para depuração",
    )
    parser.add_argument("--merge", default="", help="Diretório para salvar o modelo merged 16-bit")
    parser.add_argument("--gguf", default="", help="Diretório para salvar o GGUF q4_k_m")
    return parser.parse_args()


def require_file(path: str) -> None:
    if not Path(path).is_file():
        raise SystemExit(
            f"Arquivo não encontrado: {path}\n"
            "Rode antes:\n"
            "  npm run agent:security-dataset\n"
            "  npm run agent:security-export"
        )


def main() -> None:
    args = parse_args()
    require_file(args.train)
    require_file(args.validation)

    try:
        import torch
        from datasets import load_dataset
        from unsloth import FastLanguageModel, is_bfloat16_supported
        from unsloth.chat_templates import get_chat_template, train_on_responses_only
        from trl import SFTConfig, SFTTrainer
    except ImportError as exc:
        raise SystemExit(
            "Dependências ausentes. Em uma GPU, rode:\n"
            "  pip install -r training/requirements.txt\n"
            f"Detalhe: {exc}"
        )

    if not torch.cuda.is_available() and not args.allow_cpu:
        raise SystemExit(
            "CUDA não encontrada. Use Kaggle/Colab T4, RunPod ou outra GPU.\n"
            "O treino local desta máquina é CPU-only e não comporta QLoRA útil.\n"
            "Para apenas testar erros de sintaxe/pipeline, use --allow-cpu (experimental)."
        )

    raw = load_dataset(
        "json",
        data_files={"train": args.train, "validation": args.validation},
    )

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_length,
        dtype=None,
        load_in_4bit=True,
    )
    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

    def format_chat(examples: dict) -> dict:
        texts = [
            tokenizer.apply_chat_template(
                conversation,
                tokenize=False,
                add_generation_prompt=False,
            )
            for conversation in examples["messages"]
        ]
        return {"text": texts}

    columns = raw["train"].column_names
    dataset = raw.map(format_chat, batched=True, remove_columns=columns)

    train_ds = dataset["train"]
    validation_ds = dataset["validation"]
    if args.smoke:
        train_ds = train_ds.select(range(min(32, len(train_ds))))
        validation_ds = validation_ds.select(range(min(8, len(validation_ds))))

    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
        use_rslora=False,
        loftq_config=None,
    )

    optim = "adamw_8bit" if torch.cuda.is_available() else "adamw_torch"
    sft_args = SFTConfig(
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        warmup_steps=5,
        max_steps=10 if args.smoke else -1,
        num_train_epochs=1.0 if args.smoke else args.epochs,
        learning_rate=args.lr,
        fp16=not is_bfloat16_supported(),
        bf16=is_bfloat16_supported(),
        logging_steps=1,
        optim=optim,
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=42,
        output_dir=args.output,
        report_to="none",
        save_steps=50,
        save_strategy="no" if args.smoke else "epoch",
        eval_strategy="no" if args.smoke else "epoch",
        save_total_limit=2,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=validation_ds,
        args=sft_args,
    )
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|im_start|>user\n",
        response_part="<|im_start|>assistant\n",
    )

    print("== Iniciando QLoRA ==")
    print(f"modelo: {args.model}")
    print(f"train: {len(train_ds)} | validation: {len(validation_ds)}")
    print(f"smoke: {args.smoke} | GPU: {torch.cuda.is_available()}")
    trainer.train()

    Path(args.output).mkdir(parents=True, exist_ok=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"LoRA salvo em: {args.output}")

    if args.merge:
        print(f"Salvando merged 16-bit em: {args.merge}")
        model.save_pretrained_merged(args.merge, tokenizer, save_method="merged_16bit")

    if args.gguf:
        print(f"Exportando GGUF q4_k_m em: {args.gguf}")
        model.save_pretrained_gguf(args.gguf, tokenizer, quantization_method="q4_k_m")

    print("\nPróximos passos:")
    print("  1. Baixe o GGUF para esta máquina.")
    print("  2. Ajuste FROM no training/Modelfile.example.")
    print("  3. ollama create m5-security -f training/Modelfile.example")
    print('  4. $env:M5_MODEL_NAME="m5-security"')
    print("  5. npm run agent:ollama")
    print("  6. Avalie com o split test e compare com o baseline.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
