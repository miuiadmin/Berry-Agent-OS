export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  modelName(): string;
}

export class TfIdfEmbeddingProvider implements EmbeddingProvider {
  private vocabulary = new Map<string, number>();
  private idf = new Map<string, number>();
  private dims: number;
  private trained = false;

  constructor(dims = 256) {
    this.dims = dims;
  }

  train(corpus: string[]): void {
    const docFreq = new Map<string, number>();
    const allTokens = new Set<string>();

    for (const doc of corpus) {
      const tokens = new Set(this.tokenize(doc));
      for (const token of tokens) {
        allTokens.add(token);
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }

    const sorted = [...allTokens].sort((a, b) => (docFreq.get(b) ?? 0) - (docFreq.get(a) ?? 0));
    const selected = sorted.slice(0, this.dims);

    for (let i = 0; i < selected.length; i++) {
      this.vocabulary.set(selected[i], i);
      const df = docFreq.get(selected[i]) ?? 1;
      this.idf.set(selected[i], Math.log((corpus.length + 1) / (df + 1)) + 1);
    }
    this.trained = true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => this.embedSingle(t));
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return 'tfidf-local';
  }

  private embedSingle(text: string): number[] {
    const tokens = this.tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    const vec = new Float64Array(this.dims);
    for (const [token, count] of tf) {
      const idx = this.vocabulary.get(token);
      if (idx !== undefined) {
        const idfVal = this.idf.get(token) ?? 1;
        vec[idx] = (count / tokens.length) * idfVal;
      }
    }

    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return Array.from(vec);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
  }
}
