/**
 * Treino do M5Coder em CPU.
 *
 * Uso:
 *   npx tsx apps/agent/src/model/train-cli.ts --data dataset/code --out models/m5coder.bin --steps 400
 *   npx tsx apps/agent/src/model/train-cli.ts --smoke
 */

import fs from "node:fs";
import path from "node:path";
import { BpeTokenizer } from "./bpe";
import { loadCorpus } from "./corpus";
import { DEFAULT_GPT_CONFIG, GptConfig, GptModel, mulberry32 } from "./gpt";

interface TrainArgs {
  data: string;
  out: string;
  steps: number;
  lr: number;
  ctx: number;
  dModel: number;
  layers: number;
  heads: number;
  ffn: number;
  vocab: number;
  seed: number;
  batch: number;
  sampleChars: number;
  maxTokens: number;
  evalEvery: number;
  smoke: boolean;
  generate: string | null;
}

function parseArgs(argv: string[]): TrainArgs {
  const get = (name: string, fallback: string): string => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.split("=").slice(1).join("=");
    const idx = argv.indexOf(`--${name}`);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
    return fallback;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const root = process.cwd();
  return {
    data: path.resolve(root, get("data", "dataset/code")),
    out: path.resolve(root, get("out", "models/m5coder.bin")),
    steps: Number(get("steps", "400")),
    lr: Number(get("lr", "0.003")),
    ctx: Number(get("ctx", "128")),
    dModel: Number(get("d-model", "128")),
    layers: Number(get("layers", "2")),
    heads: Number(get("heads", "4")),
    ffn: Number(get("ffn", "320")),
    vocab: Number(get("vocab", "1536")),
    seed: Number(get("seed", "42")),
    batch: Number(get("batch", "1")),
    sampleChars: Number(get("sample-chars", "3000000")),
    maxTokens: Number(get("max-tokens", "1500000")),
    evalEvery: Number(get("eval-every", "50")),
    smoke: flag("smoke"),
    generate: get("generate", ""),
  };
}

function sampleWindows(tokens: Uint16Array, ctx: number, count: number, rng: () => number): Array<{ input: number[]; target: number[] }> {
  const windows: Array<{ input: number[]; target: number[] }> = [];
  if (tokens.length <= ctx + 1) return windows;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rng() * (tokens.length - ctx - 1));
    const input: number[] = [];
    const target: number[] = [];
    for (let t = 0; t < ctx; t++) {
      input.push(tokens[start + t]);
      target.push(tokens[start + t + 1]);
    }
    windows.push({ input, target });
  }
  return windows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.smoke) {
    args.steps = Math.min(args.steps, 20);
    args.dModel = Math.min(args.dModel, 64);
    args.layers = Math.min(args.layers, 1);
    args.heads = Math.min(args.heads, 4);
    args.ffn = Math.min(args.ffn, 128);
    args.ctx = Math.min(args.ctx, 64);
    args.vocab = Math.min(args.vocab, 640);
    args.maxTokens = Math.min(args.maxTokens, 60_000);
    args.sampleChars = Math.min(args.sampleChars, 120_000);
    args.out = path.resolve("models", "m5coder-smoke.bin");
  }

  console.log("== M5Coder treino ==");
  console.log(`dados: ${args.data}`);

  const corpus = loadCorpus(args.data, args.sampleChars);
  if (corpus.text.trim().length < 200) {
    throw new Error("Corpus muito pequeno. Rode a geração de dataset primeiro: npm run dataset");
  }
  console.log(
    `corpus: ${corpus.text.length.toLocaleString()} chars | arquivos=${corpus.files} amostras=${corpus.samples} linguagens=${Object.keys(corpus.languages).length}`,
  );

  const t0 = Date.now();
  const tokenizer = BpeTokenizer.train(corpus.text, {
    vocabSize: args.vocab,
    sampleChars: Math.min(args.sampleChars, 1_500_000),
  });
  console.log(`BPE: vocab=${tokenizer.vocabSize} merges=${tokenizer.mergeCount} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const ids = tokenizer.encode(corpus.text.slice(0, args.sampleChars));
  const tokens = Uint16Array.from(ids.slice(0, args.maxTokens));
  console.log(`tokens: ${tokens.length.toLocaleString()} (${(tokens.length / Math.max(1, corpus.text.length)).toFixed(2)} tokens/char)`);

  const config: GptConfig = {
    ...DEFAULT_GPT_CONFIG,
    vocabSize: tokenizer.vocabSize,
    dModel: args.dModel,
    nLayer: args.layers,
    nHead: args.heads,
    dFfn: args.ffn,
    ctx: args.ctx,
  };
  const model = new GptModel(config, args.seed);
  console.log(`params: ${model.numParams().toLocaleString()} | ctx=${config.ctx} d=${config.dModel} layers=${config.nLayer} heads=${config.nHead}`);

  const split = Math.floor(tokens.length * 0.95);
  const trainTokens = tokens.subarray(0, split);
  const valTokens = tokens.subarray(split);

  const rng = mulberry32(args.seed);
  const valWindows = sampleWindows(valTokens, config.ctx, 8, mulberry32(args.seed + 1));
  let bestVal = Infinity;
  const totalSteps = args.steps;
  const t1 = Date.now();
  let lossEma = 0;

  for (let step = 1; step <= totalSteps; step++) {
    // warmup + cosine
    const lr = args.lr * Math.min(1, step / Math.max(1, Math.floor(totalSteps * 0.05)))
      * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * (step / totalSteps))));

    let loss = 0;
    for (let b = 0; b < args.batch; b++) {
      const [window] = sampleWindows(trainTokens, config.ctx, 1, rng);
      if (!window) break;
      const cache = model.forward(window.input);
      loss += model.backward(cache, window.target);
    }
    const gradNorm = model.step(lr / Math.max(1, args.batch), { clip: 1.0 });

    lossEma = step === 1 ? loss : lossEma * 0.95 + loss * 0.05;

    if (step % 10 === 0 || step === 1) {
      const elapsed = (Date.now() - t1) / 1000;
      const tokensPerSec = ((step * config.ctx) / Math.max(0.001, elapsed)).toFixed(0);
      console.log(
        `step ${step}/${totalSteps} loss=${loss.toFixed(4)} ema=${lossEma.toFixed(4)} lr=${lr.toExponential(2)} gnorm=${gradNorm.toFixed(2)} ${tokensPerSec} tok/s`,
      );
    }

    if (step % args.evalEvery === 0 || step === totalSteps) {
      let val = 0;
      let n = 0;
      for (const window of valWindows) {
        const cache = model.forward(window.input);
        val += model.backward(cache, window.target);
        n += 1;
        model.zeroGrad();
      }
      val /= Math.max(1, n);
      console.log(`  val loss=${val.toFixed(4)}`);
      if (val < bestVal) bestVal = val;
      if (val > bestVal * 1.5 && step > args.evalEvery * 2) {
        console.log("  early stop: val piorando");
        break;
      }
    }
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  model.save(args.out, tokenizer, { steps: totalSteps, loss: lossEma });
  const size = fs.statSync(args.out).size;
  console.log(`checkpoint: ${args.out} (${(size / 1_048_576).toFixed(2)} MB) em ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (args.generate) {
    const prompt = `### USER\n${args.generate}\n\n### ASSISTANT\n`;
    const outIds = tokenizer.encode(prompt);
    const generated = model.generate(outIds, {
      maxNewTokens: 120,
      temperature: 0.6,
      topP: 0.9,
      stopIds: [],
    });
    console.log("\n--- amostra ---");
    console.log(tokenizer.decode(generated));
    console.log("--- fim ---");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
