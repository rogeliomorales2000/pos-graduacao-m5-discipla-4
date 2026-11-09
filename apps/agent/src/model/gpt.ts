/**
 * GPT mínimo (decoder-only) escrito à mão: forward, backward e AdamW.
 *
 * Pensado para treinar em CPU com poucos milhões de parâmetros. Tudo em
 * Float32Array; atenção causal multi-head; pesos de embedding compartilhados
 * com a cabeça de saída (weight tying).
 */

import fs from "node:fs";
import { BpeData, BpeTokenizer } from "./bpe";

export interface GptConfig {
  vocabSize: number;
  dModel: number;
  nLayer: number;
  nHead: number;
  dFfn: number;
  ctx: number;
  eps: number;
}

export const DEFAULT_GPT_CONFIG: Omit<GptConfig, "vocabSize"> = {
  dModel: 128,
  nLayer: 2,
  nHead: 4,
  dFfn: 320,
  ctx: 128,
  eps: 1e-5,
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function zeros(n: number): Float32Array {
  return new Float32Array(n);
}

function fillNormal(arr: Float32Array, std: number, rng: () => number): void {
  for (let i = 0; i < arr.length; i++) arr[i] = normal(rng) * std;
}

function layerNorm(
  x: Float32Array,
  g: Float32Array,
  b: Float32Array,
  T: number,
  D: number,
  eps: number,
): { y: Float32Array; yhat: Float32Array; rstd: Float32Array } {
  const y = new Float32Array(T * D);
  const yhat = new Float32Array(T * D);
  const rstd = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const base = t * D;
    let sum = 0;
    for (let i = 0; i < D; i++) sum += x[base + i];
    const m = sum / D;
    let variance = 0;
    for (let i = 0; i < D; i++) {
      const d = x[base + i] - m;
      variance += d * d;
    }
    variance /= D;
    const r = 1 / Math.sqrt(variance + eps);
    rstd[t] = r;
    for (let i = 0; i < D; i++) {
      const h = (x[base + i] - m) * r;
      yhat[base + i] = h;
      y[base + i] = h * g[i] + b[i];
    }
  }
  return { y, yhat, rstd };
}

function layerNormBackward(
  dy: Float32Array,
  cache: { y: Float32Array; yhat: Float32Array; rstd: Float32Array },
  g: Float32Array,
  T: number,
  D: number,
  dx: Float32Array,
  dg: Float32Array,
  db: Float32Array,
): void {
  for (let t = 0; t < T; t++) {
    const base = t * D;
    let sumDyG = 0;
    let sumDyGYhat = 0;
    for (let i = 0; i < D; i++) {
      const dyi = dy[base + i];
      sumDyG += dyi * g[i];
      sumDyGYhat += dyi * g[i] * cache.yhat[base + i];
    }
    const rstd = cache.rstd[t];
    for (let i = 0; i < D; i++) {
      const dyi = dy[base + i];
      const yhat = cache.yhat[base + i];
      dx[base + i] += (rstd / D) * (D * dyi * g[i] - sumDyG - yhat * sumDyGYhat);
      dg[i] += dyi * yhat;
      db[i] += dyi;
    }
  }
}

function gelu(x: number): number {
  const c = Math.sqrt(2 / Math.PI);
  return 0.5 * x * (1 + Math.tanh(c * (x + 0.044715 * x * x * x)));
}

function geluBackward(x: number): number {
  const c = Math.sqrt(2 / Math.PI);
  const u = c * (x + 0.044715 * x * x * x);
  const t = Math.tanh(u);
  return 0.5 * (1 + t) + 0.5 * x * (1 - t * t) * c * (1 + 3 * 0.044715 * x * x);
}

function softmaxInPlace(arr: Float32Array, offset: number, length: number): void {
  let max = -Infinity;
  for (let i = 0; i < length; i++) max = Math.max(max, arr[offset + i]);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const v = Math.exp(arr[offset + i] - max);
    arr[offset + i] = v;
    sum += v;
  }
  const inv = 1 / (sum || 1);
  for (let i = 0; i < length; i++) arr[offset + i] *= inv;
}

interface LayerCache {
  ln1: ReturnType<typeof layerNorm>;
  qkv: Float32Array;
  probs: Float32Array[];
  attnCat: Float32Array;
  proj: Float32Array;
  h1: Float32Array;
  ln2: ReturnType<typeof layerNorm>;
  ffnPre: Float32Array;
  ffnAct: Float32Array;
  h2: Float32Array;
}

export interface GptCache {
  ids: number[];
  T: number;
  x0: Float32Array;
  layers: LayerCache[];
  lnf: ReturnType<typeof layerNorm>;
  logits: Float32Array;
}

export interface GptArtifactHeader {
  config: GptConfig;
  params: Array<{ name: string; size: number }>;
  bpe: BpeData;
  trainedAt?: string;
  steps?: number;
  loss?: number;
}

const MAGIC = "M5GPT1\n";

export class GptModel {
  readonly config: GptConfig;
  readonly p = new Map<string, Float32Array>();
  readonly g = new Map<string, Float32Array>();
  private readonly m = new Map<string, Float32Array>();
  private readonly v = new Map<string, Float32Array>();
  private stepCount = 0;

  constructor(config: GptConfig, seed = 42) {
    this.config = config;
    const rng = mulberry32(seed);
    const d = config.dModel;
    const add = (name: string, size: number, std: number): void => {
      const arr = zeros(size);
      fillNormal(arr, std, rng);
      this.p.set(name, arr);
      this.g.set(name, zeros(size));
      this.m.set(name, zeros(size));
      this.v.set(name, zeros(size));
    };

    add("wte", config.vocabSize * d, 0.02);
    add("wpe", config.ctx * d, 0.01);
    for (let l = 0; l < config.nLayer; l++) {
      add(`l${l}.ln1g`, d, 0.0);
      this.p.get(`l${l}.ln1g`)!.fill(1);
      add(`l${l}.ln1b`, d, 0.0);
      add(`l${l}.wqkv`, d * 3 * d, 1 / Math.sqrt(d));
      add(`l${l}.wo`, d * d, 1 / Math.sqrt(d));
      add(`l${l}.ln2g`, d, 0.0);
      this.p.get(`l${l}.ln2g`)!.fill(1);
      add(`l${l}.ln2b`, d, 0.0);
      add(`l${l}.fc1`, d * config.dFfn, 1 / Math.sqrt(d));
      add(`l${l}.fc2`, config.dFfn * d, 1 / Math.sqrt(config.dFfn));
    }
    add("lnfg", d, 0.0);
    this.p.get("lnfg")!.fill(1);
    add("lnfb", d, 0.0);
  }

  get vocabSize(): number {
    return this.config.vocabSize;
  }

  numParams(): number {
    let n = 0;
    for (const arr of this.p.values()) n += arr.length;
    return n;
  }

  zeroGrad(): void {
    for (const arr of this.g.values()) arr.fill(0);
  }

  forward(ids: number[]): GptCache {
    const { dModel: d, nLayer, nHead, dFfn, ctx, eps } = this.config;
    const T = ids.length;
    if (T === 0) throw new Error("forward precisa de ao menos 1 token");
    if (T > ctx) throw new Error(`sequência ${T} > contexto ${ctx}`);
    const hd = d / nHead;

    const wte = this.p.get("wte")!;
    const wpe = this.p.get("wpe")!;
    const x0 = new Float32Array(T * d);
    for (let t = 0; t < T; t++) {
      const id = ids[t];
      const tokBase = id * d;
      const posBase = t * d;
      for (let i = 0; i < d; i++) x0[t * d + i] = wte[tokBase + i] + wpe[posBase + i];
    }

    let x = x0;
    const layers: LayerCache[] = [];

    for (let l = 0; l < nLayer; l++) {
      const ln1g = this.p.get(`l${l}.ln1g`)!;
      const ln1b = this.p.get(`l${l}.ln1b`)!;
      const wqkv = this.p.get(`l${l}.wqkv`)!;
      const wo = this.p.get(`l${l}.wo`)!;

      const ln1 = layerNorm(x, ln1g, ln1b, T, d, eps);

      // qkv[t, 0..d) = Q, [d..2d) = K, [2d..3d) = V
      const qkv = new Float32Array(T * 3 * d);
      for (let t = 0; t < T; t++) {
        for (let o = 0; o < 3 * d; o++) {
          let sum = 0;
          const rowBase = t * d;
          for (let i = 0; i < d; i++) sum += ln1.y[rowBase + i] * wqkv[i * 3 * d + o];
          qkv[t * 3 * d + o] = sum;
        }
      }

      const probs: Float32Array[] = [];
      const attnCat = new Float32Array(T * d);
      const scale = 1 / Math.sqrt(hd);

      for (let h = 0; h < nHead; h++) {
        const pmat = new Float32Array(T * T);
        for (let t = 0; t < T; t++) {
          // Apenas posições <= t (causal).
          for (let s = 0; s <= t; s++) {
            let dot = 0;
            for (let i = 0; i < hd; i++) {
              dot += qkv[t * 3 * d + h * hd + i] * qkv[s * 3 * d + d + h * hd + i];
            }
            pmat[t * T + s] = dot * scale;
          }
          for (let s = t + 1; s < T; s++) pmat[t * T + s] = -Infinity;
          softmaxInPlace(pmat, t * T, T);
        }
        probs.push(pmat);

        // out[t, h*hd+i] = sum_s p[t,s] * V[s, h*hd+i]
        for (let t = 0; t < T; t++) {
          for (let i = 0; i < hd; i++) {
            let sum = 0;
            for (let s = 0; s <= t; s++) {
              sum += pmat[t * T + s] * qkv[s * 3 * d + 2 * d + h * hd + i];
            }
            attnCat[t * d + h * hd + i] = sum;
          }
        }
      }

      const proj = new Float32Array(T * d);
      for (let t = 0; t < T; t++) {
        for (let o = 0; o < d; o++) {
          let sum = 0;
          for (let i = 0; i < d; i++) sum += attnCat[t * d + i] * wo[i * d + o];
          proj[t * d + o] = sum;
        }
      }

      const h1 = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) h1[i] = x[i] + proj[i];

      const ln2g = this.p.get(`l${l}.ln2g`)!;
      const ln2b = this.p.get(`l${l}.ln2b`)!;
      const ln2 = layerNorm(h1, ln2g, ln2b, T, d, eps);

      const fc1 = this.p.get(`l${l}.fc1`)!;
      const fc2 = this.p.get(`l${l}.fc2`)!;
      const ffnPre = new Float32Array(T * dFfn);
      for (let t = 0; t < T; t++) {
        for (let o = 0; o < dFfn; o++) {
          let sum = 0;
          for (let i = 0; i < d; i++) sum += ln2.y[t * d + i] * fc1[i * dFfn + o];
          ffnPre[t * dFfn + o] = sum;
        }
      }
      const ffnAct = new Float32Array(T * dFfn);
      for (let i = 0; i < ffnAct.length; i++) ffnAct[i] = gelu(ffnPre[i]);

      const h2 = new Float32Array(T * d);
      for (let t = 0; t < T; t++) {
        for (let o = 0; o < d; o++) {
          let sum = 0;
          for (let k = 0; k < dFfn; k++) sum += ffnAct[t * dFfn + k] * fc2[k * d + o];
          h2[t * d + o] = h1[t * d + o] + sum;
        }
      }

      layers.push({ ln1, qkv, probs, attnCat, proj, h1, ln2, ffnPre, ffnAct, h2 });
      x = h2;
    }

    const lnfg = this.p.get("lnfg")!;
    const lnfb = this.p.get("lnfb")!;
    const lnf = layerNorm(x, lnfg, lnfb, T, d, eps);
    const V = this.config.vocabSize;
    const logits = new Float32Array(T * V);
    for (let t = 0; t < T; t++) {
      for (let v = 0; v < V; v++) {
        let sum = 0;
        for (let i = 0; i < d; i++) sum += lnf.y[t * d + i] * wte[v * d + i];
        logits[t * V + v] = sum;
      }
    }

    return { ids, T, x0, layers, lnf, logits };
  }

  /** Cross-entropy média + backward acumulado em this.g. Retorna a loss. */
  backward(cache: GptCache, targets: number[]): number {
    const { dModel: d, nLayer, nHead, dFfn, ctx, eps } = this.config;
    const T = cache.T;
    const V = this.config.vocabSize;
    const hd = d / nHead;
    const dLogits = new Float32Array(T * V);
    let loss = 0;

    for (let t = 0; t < T; t++) {
      const row = cache.logits.subarray(t * V, t * V + V);
      let max = -Infinity;
      for (let i = 0; i < V; i++) max = Math.max(max, row[i]);
      let sum = 0;
      const probs = new Float32Array(V);
      for (let i = 0; i < V; i++) {
        const e = Math.exp(row[i] - max);
        probs[i] = e;
        sum += e;
      }
      const inv = 1 / sum;
      for (let i = 0; i < V; i++) probs[i] *= inv;
      const target = targets[t];
      const pTarget = Math.max(1e-9, probs[target] ?? 1e-9);
      loss += -Math.log(pTarget);
      for (let i = 0; i < V; i++) dLogits[t * V + i] = probs[i];
      dLogits[t * V + target] -= 1;
    }
    loss /= T;
    for (let i = 0; i < dLogits.length; i++) dLogits[i] /= T;

    const wte = this.p.get("wte")!;
    const dwte = this.g.get("wte")!;
    const lnfg = this.p.get("lnfg")!;
    const lnfb = this.p.get("lnfb")!;
    const dwpe = this.g.get("wpe")!;
    const dlnfg = this.g.get("lnfg")!;
    const dlnfb = this.g.get("lnfb")!;

    // dLnfY = dLogits @ wte ; dWte += dLogits^T @ lnfY
    const dLnfY = new Float32Array(T * d);
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < d; i++) {
        let sum = 0;
        for (let v = 0; v < V; v++) sum += dLogits[t * V + v] * wte[v * d + i];
        dLnfY[t * d + i] = sum;
      }
      for (let v = 0; v < V; v++) {
        const dv = dLogits[t * V + v];
        if (dv === 0) continue;
        for (let i = 0; i < d; i++) dwte[v * d + i] += dv * cache.lnf.y[t * d + i];
      }
    }

    const dx = new Float32Array(T * d);
    layerNormBackward(dLnfY, cache.lnf, lnfg, T, d, dx, dlnfg, dlnfb);
    let dX = dx;

    for (let l = nLayer - 1; l >= 0; l--) {
      const layer = cache.layers[l];
      const dH2 = dX;
      // Residual: h2 = h1 + ffnOut
      const dH1 = new Float32Array(T * d);
      dH1.set(dH2);

      // fc2
      const dFfnAct = new Float32Array(T * dFfn);
      const dfc2 = this.g.get(`l${l}.fc2`)!;
      for (let t = 0; t < T; t++) {
        for (let k = 0; k < dFfn; k++) {
          let sum = 0;
          for (let o = 0; o < d; o++) sum += dH2[t * d + o] * this.p.get(`l${l}.fc2`)![k * d + o];
          dFfnAct[t * dFfn + k] = sum;
        }
        for (let k = 0; k < dFfn; k++) {
          const act = layer.ffnAct[t * dFfn + k];
          if (act === 0) continue;
          for (let o = 0; o < d; o++) dfc2[k * d + o] += act * dH2[t * d + o];
        }
      }

      // gelu backward
      const dFfnPre = new Float32Array(T * dFfn);
      for (let i = 0; i < dFfnPre.length; i++) {
        dFfnPre[i] = dFfnAct[i] * geluBackward(layer.ffnPre[i]);
      }

      // fc1
      const dLn2Y = new Float32Array(T * d);
      const dfc1 = this.g.get(`l${l}.fc1`)!;
      for (let t = 0; t < T; t++) {
        for (let i = 0; i < d; i++) {
          let sum = 0;
          for (let k = 0; k < dFfn; k++) sum += dFfnPre[t * dFfn + k] * this.p.get(`l${l}.fc1`)![i * dFfn + k];
          dLn2Y[t * d + i] = sum;
        }
        for (let i = 0; i < d; i++) {
          const yv = layer.ln2.y[t * d + i];
          if (yv === 0) continue;
          for (let k = 0; k < dFfn; k++) dfc1[i * dFfn + k] += yv * dFfnPre[t * dFfn + k];
        }
      }

      // ln2 backward -> soma no residual h1
      const dLn2 = new Float32Array(T * d);
      layerNormBackward(
        dLn2Y,
        layer.ln2,
        this.p.get(`l${l}.ln2g`)!,
        T,
        d,
        dLn2,
        this.g.get(`l${l}.ln2g`)!,
        this.g.get(`l${l}.ln2b`)!,
      );
      for (let i = 0; i < T * d; i++) dH1[i] += dLn2[i];

      // projeção de atenção
      const dAttnCat = new Float32Array(T * d);
      const dwo = this.g.get(`l${l}.wo`)!;
      for (let t = 0; t < T; t++) {
        for (let i = 0; i < d; i++) {
          let sum = 0;
          for (let o = 0; o < d; o++) sum += dH1[t * d + o] * this.p.get(`l${l}.wo`)![i * d + o];
          dAttnCat[t * d + i] = sum;
        }
        for (let i = 0; i < d; i++) {
          const ac = layer.attnCat[t * d + i];
          if (ac === 0) continue;
          for (let o = 0; o < d; o++) dwo[i * d + o] += ac * dH1[t * d + o];
        }
      }

      // atenção
      const dQkv = new Float32Array(T * 3 * d);
      const scale = 1 / Math.sqrt(hd);
      for (let h = 0; h < nHead; h++) {
        const pmat = layer.probs[h];
        const dHeadOut = new Float32Array(T * hd);
        for (let t = 0; t < T; t++) {
          for (let i = 0; i < hd; i++) dHeadOut[t * hd + i] = dAttnCat[t * d + h * hd + i];
        }

        const dProbs = new Float32Array(T * T);
        const dV = new Float32Array(T * hd);
        for (let t = 0; t < T; t++) {
          for (let s = 0; s <= t; s++) {
            let sum = 0;
            for (let i = 0; i < hd; i++) sum += dHeadOut[t * hd + i] * layer.qkv[s * 3 * d + 2 * d + h * hd + i];
            dProbs[t * T + s] = sum;
          }
          for (let s = 0; s <= t; s++) {
            const p = pmat[t * T + s];
            for (let i = 0; i < hd; i++) dV[s * hd + i] += p * dHeadOut[t * hd + i];
          }
        }

        // softmax backward por linha
        const dScores = new Float32Array(T * T);
        for (let t = 0; t < T; t++) {
          let dot = 0;
          for (let s = 0; s < T; s++) dot += dProbs[t * T + s] * pmat[t * T + s];
          for (let s = 0; s < T; s++) {
            const p = pmat[t * T + s];
            dScores[t * T + s] = p * (dProbs[t * T + s] - dot) * scale;
          }
        }

        for (let t = 0; t < T; t++) {
          for (let i = 0; i < hd; i++) {
            let dq = 0;
            for (let s = 0; s <= t; s++) dq += dScores[t * T + s] * layer.qkv[s * 3 * d + d + h * hd + i];
            dQkv[t * 3 * d + h * hd + i] += dq;
          }
        }
        for (let s = 0; s < T; s++) {
          for (let i = 0; i < hd; i++) {
            let dk = 0;
            for (let t = s; t < T; t++) dk += dScores[t * T + s] * layer.qkv[t * 3 * d + h * hd + i];
            dQkv[s * 3 * d + d + h * hd + i] += dk;
            dQkv[s * 3 * d + 2 * d + h * hd + i] += dV[s * hd + i];
          }
        }
      }

      // wqkv
      const dLn1Y = new Float32Array(T * d);
      const dwqkv = this.g.get(`l${l}.wqkv`)!;
      for (let t = 0; t < T; t++) {
        for (let i = 0; i < d; i++) {
          let sum = 0;
          for (let o = 0; o < 3 * d; o++) sum += dQkv[t * 3 * d + o] * this.p.get(`l${l}.wqkv`)![i * 3 * d + o];
          dLn1Y[t * d + i] = sum;
        }
        for (let i = 0; i < d; i++) {
          const yv = layer.ln1.y[t * d + i];
          if (yv === 0) continue;
          for (let o = 0; o < 3 * d; o++) dwqkv[i * 3 * d + o] += yv * dQkv[t * 3 * d + o];
        }
      }

      const dLn1 = new Float32Array(T * d);
      layerNormBackward(
        dLn1Y,
        layer.ln1,
        this.p.get(`l${l}.ln1g`)!,
        T,
        d,
        dLn1,
        this.g.get(`l${l}.ln1g`)!,
        this.g.get(`l${l}.ln1b`)!,
      );
      // residual da entrada do bloco
      const dNext = new Float32Array(T * d);
      for (let i = 0; i < T * d; i++) dNext[i] = dH1[i] + dLn1[i];
      dX = dNext;
    }

    // embeddings de token e posição
    for (let t = 0; t < T; t++) {
      const id = cache.ids[t];
      const tokBase = id * d;
      const posBase = t * d;
      for (let i = 0; i < d; i++) {
        dwte[tokBase + i] += dX[t * d + i];
        dwpe[posBase + i] += dX[t * d + i];
      }
    }

    void ctx;
    void eps;
    void dFfn;
    return loss;
  }

  /** AdamW com clipping global. */
  step(learningRate: number, options: { weightDecay?: number; beta1?: number; beta2?: number; clip?: number } = {}): number {
    const wd = options.weightDecay ?? 0.01;
    const b1 = options.beta1 ?? 0.9;
    const b2 = options.beta2 ?? 0.95;
    const clip = options.clip ?? 1.0;
    this.stepCount += 1;

    let norm = 0;
    for (const grad of this.g.values()) {
      for (let i = 0; i < grad.length; i++) norm += grad[i] * grad[i];
    }
    norm = Math.sqrt(norm);
    const scale = norm > clip ? clip / (norm + 1e-9) : 1;

    const bc1 = 1 - Math.pow(b1, this.stepCount);
    const bc2 = 1 - Math.pow(b2, this.stepCount);

    for (const [name, param] of this.p) {
      const grad = this.g.get(name)!;
      const m = this.m.get(name)!;
      const v = this.v.get(name)!;
      for (let i = 0; i < param.length; i++) {
        const gi = grad[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        const mHat = m[i] / bc1;
        const vHat = v[i] / bc2;
        // weight decay apenas em matrizes (não em layernorm/bias)
        const decay = name.endsWith("g") || name.endsWith("b") ? 0 : wd;
        param[i] -= learningRate * (mHat / (Math.sqrt(vHat) + 1e-8) + decay * param[i]);
      }
    }
    return norm;
  }

  generate(
    ids: number[],
    options: { maxNewTokens?: number; temperature?: number; topP?: number; stopIds?: number[]; rng?: () => number } = {},
  ): number[] {
    const maxNew = options.maxNewTokens ?? 64;
    const temperature = options.temperature ?? 0.8;
    const topP = options.topP ?? 0.95;
    const rng = options.rng ?? Math.random;
    const stop = new Set(options.stopIds ?? []);
    const out = ids.slice();
    const V = this.config.vocabSize;

    for (let n = 0; n < maxNew; n++) {
      const ctxIds = out.slice(-this.config.ctx);
      const cache = this.forward(ctxIds);
      const T = cache.T;
      const row = cache.logits.subarray((T - 1) * V, T * V);

      let next: number;
      if (temperature <= 0) {
        let best = 0;
        for (let i = 1; i < V; i++) if (row[i] > row[best]) best = i;
        next = best;
      } else {
        const scaled = new Float32Array(V);
        for (let i = 0; i < V; i++) scaled[i] = row[i] / temperature;
        softmaxInPlace(scaled, 0, V);

        // nucleus
        const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => scaled[b] - scaled[a]);
        let cumulative = 0;
        let cutoff = V;
        for (let i = 0; i < order.length; i++) {
          cumulative += scaled[order[i]];
          if (cumulative >= topP) {
            cutoff = i + 1;
            break;
          }
        }
        let r = rng() * Math.min(1, cumulative);
        next = order[0];
        for (let i = 0; i < cutoff; i++) {
          r -= scaled[order[i]];
          if (r <= 0) {
            next = order[i];
            break;
          }
        }
      }

      out.push(next);
      if (stop.has(next)) break;
    }
    return out;
  }

  save(file: string, tokenizer: BpeTokenizer, extra: { steps?: number; loss?: number } = {}): void {
    const header: GptArtifactHeader = {
      config: this.config,
      params: [...this.p.entries()].map(([name, arr]) => ({ name, size: arr.length })),
      bpe: tokenizer.toJSON(),
      trainedAt: new Date().toISOString(),
      steps: extra.steps,
      loss: extra.loss,
    };
    const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
    const parts: Buffer[] = [Buffer.from(MAGIC, "utf8")];
    const len = Buffer.alloc(4);
    len.writeUInt32LE(headerBuf.length, 0);
    parts.push(len, headerBuf);
    for (const [, arr] of this.p) {
      parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    }
    fs.writeFileSync(file, Buffer.concat(parts));
  }

  static load(file: string): { model: GptModel; tokenizer: BpeTokenizer; header: GptArtifactHeader } {
    const buf = fs.readFileSync(file);
    const magic = buf.subarray(0, MAGIC.length).toString("utf8");
    if (magic !== MAGIC) throw new Error(`Checkpoint inválido: ${file}`);
    let offset = MAGIC.length;
    const headerLen = buf.readUInt32LE(offset);
    offset += 4;
    const header = JSON.parse(buf.subarray(offset, offset + headerLen).toString("utf8")) as GptArtifactHeader;
    offset += headerLen;

    const model = new GptModel(header.config);
    for (const { name, size } of header.params) {
      const arr = new Float32Array(size);
      const byteLen = size * 4;
      const src = new Uint8Array(buf.buffer, buf.byteOffset + offset, byteLen);
      new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(src);
      offset += byteLen;
      model.p.set(name, arr);
    }
    return { model, tokenizer: new BpeTokenizer(header.bpe), header };
  }
}
