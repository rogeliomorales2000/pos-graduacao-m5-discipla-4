/**
 * BPE byte-level treinável, sem dependências.
 *
 * - 4 tokens especiais (pad/bos/eos/unk)
 * - 256 tokens de byte
 * - merges aprendidos sobre tipos de "palavra" (pre-tokenização estilo GPT-2)
 *
 * O vocabulário é reconstruído a partir dos merges, então o checkpoint é pequeno.
 */

export const SPECIALS = ["<pad>", "<bos>", "<eos>", "<unk>"] as const;
export const PAD = 0;
export const BOS = 1;
export const EOS = 2;
export const UNK = 3;
const BYTE_OFFSET = SPECIALS.length;
const FIRST_MERGE = BYTE_OFFSET + 256;

export interface BpeData {
  type: "bpe";
  version: 1;
  vocabSize: number;
  merges: Array<[number, number]>;
}

const PRETOKEN =
  /\s*[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;

function pretokenize(text: string): string[] {
  const out = text.match(PRETOKEN);
  return out ?? [];
}

function bytesOf(text: string): number[] {
  return [...Buffer.from(text, "utf8")];
}

function toIds(bytes: number[]): number[] {
  return bytes.map((b) => b + BYTE_OFFSET);
}

export class BpeTokenizer {
  readonly merges: Array<[number, number]>;
  readonly vocabSize: number;
  private readonly ranks: Map<number, number>;
  private readonly expansions: Uint8Array[] = [];

  constructor(data: BpeData) {
    this.merges = data.merges.map(([a, b]) => [a, b]);
    this.vocabSize = data.vocabSize;
    this.ranks = new Map();
    for (let i = 0; i < this.merges.length; i++) {
      const [a, b] = this.merges[i];
      this.ranks.set((a << 16) | b, i);
    }
    for (let i = 0; i < SPECIALS.length; i++) this.expansions.push(Buffer.from(SPECIALS[i], "utf8"));
    for (let b = 0; b < 256; b++) this.expansions.push(Uint8Array.from([b]));
    for (const [a, b] of this.merges) {
      const left = this.expansions[a];
      const right = this.expansions[b];
      if (!left || !right) throw new Error(`Merge inválido: ${a}+${b}`);
      const merged = new Uint8Array(left.length + right.length);
      merged.set(left, 0);
      merged.set(right, left.length);
      this.expansions.push(merged);
    }
  }

  static train(text: string, options: { vocabSize?: number; sampleChars?: number; minFrequency?: number } = {}): BpeTokenizer {
    const vocabSize = options.vocabSize ?? 1536;
    const sampleChars = options.sampleChars ?? 1_500_000;
    const minFrequency = options.minFrequency ?? 2;
    const sample = text.length > sampleChars ? text.slice(0, sampleChars) : text;

    // Frequência de tipos de palavra: cada tipo é processado uma vez.
    const freq = new Map<string, number>();
    for (const word of pretokenize(sample)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }

    interface Word { ids: number[]; count: number }
    const words: Word[] = [...freq.entries()].map(([word, count]) => ({ ids: toIds(bytesOf(word)), count }));

    const merges: Array<[number, number]> = [];
    const maxMerges = Math.max(0, vocabSize - FIRST_MERGE);

    while (merges.length < maxMerges) {
      const pairCounts = new Map<number, number>();
      const pairFirstSeen = new Map<number, [number, number]>();
      for (const word of words) {
        if (word.ids.length < 2) continue;
        for (let i = 0; i < word.ids.length - 1; i++) {
          const key = (word.ids[i] << 16) | word.ids[i + 1];
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + word.count);
          if (!pairFirstSeen.has(key)) pairFirstSeen.set(key, [word.ids[i], word.ids[i + 1]]);
        }
      }

      let bestKey = -1;
      let bestCount = 0;
      for (const [key, count] of pairCounts) {
        if (count > bestCount || (count === bestCount && key < bestKey)) {
          bestCount = count;
          bestKey = key;
        }
      }
      if (bestKey < 0 || bestCount < minFrequency) break;

      const pair = pairFirstSeen.get(bestKey)!;
      const newId = FIRST_MERGE + merges.length;
      merges.push(pair);

      for (const word of words) {
        const ids = word.ids;
        if (ids.length < 2) continue;
        let write = 0;
        for (let read = 0; read < ids.length; read++) {
          if (read < ids.length - 1 && ids[read] === pair[0] && ids[read + 1] === pair[1]) {
            ids[write++] = newId;
            read++;
          } else {
            ids[write++] = ids[read];
          }
        }
        ids.length = write;
      }
    }

    return new BpeTokenizer({ type: "bpe", version: 1, vocabSize: FIRST_MERGE + merges.length, merges });
  }

  private mergeWord(ids: number[]): number[] {
    if (ids.length < 2) return ids;
    let current = ids.slice();
    for (;;) {
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;
      for (let i = 0; i < current.length - 1; i++) {
        const rank = this.ranks.get((current[i] << 16) | current[i + 1]);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;
      const merged = FIRST_MERGE + bestRank;
      const next: number[] = [];
      for (let i = 0; i < current.length; i++) {
        if (i === bestIndex) {
          next.push(merged);
          i += 1;
        } else {
          next.push(current[i]);
        }
      }
      current = next;
      if (current.length < 2) break;
    }
    return current;
  }

  encode(text: string, options: { addBos?: boolean; addEos?: boolean; maxTokens?: number } = {}): number[] {
    const ids: number[] = [];
    if (options.addBos) ids.push(BOS);
    for (const word of pretokenize(text)) {
      const merged = this.mergeWord(toIds(bytesOf(word)));
      for (const id of merged) {
        if (id >= this.vocabSize) ids.push(UNK);
        else ids.push(id);
      }
      if (options.maxTokens && ids.length >= options.maxTokens) break;
    }
    if (options.addEos) ids.push(EOS);
    return options.maxTokens ? ids.slice(0, options.maxTokens) : ids;
  }

  decode(ids: number[]): string {
    const parts: Buffer[] = [];
    for (const id of ids) {
      if (id < SPECIALS.length) continue;
      const expansion = this.expansions[id];
      if (expansion) parts.push(Buffer.from(expansion));
    }
    return Buffer.concat(parts).toString("utf8");
  }

  toJSON(): BpeData {
    return { type: "bpe", version: 1, vocabSize: this.vocabSize, merges: this.merges };
  }

  get mergeCount(): number {
    return this.merges.length;
  }
}

export function encodeCorpus(text: string, tokenizer: BpeTokenizer): Uint16Array {
  const ids = tokenizer.encode(text);
  const out = new Uint16Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = ids[i];
  return out;
}
