import { GraphError } from "../api/errors";
import type { Tunable, Tune } from "../engine/Tune";

export class Lazy<T> {
  value: T | null = null;
  private pending: Promise<T> | null = null;

  constructor(private readonly make: () => Promise<T>) {}

  get loading(): boolean {
    return this.pending !== null && this.value === null;
  }

  load(): Promise<T> {
    this.pending ??= this.make().then(
      (v) => (this.value = v),
      (e: unknown) => {
        this.pending = null;
        throw e;
      },
    );
    return this.pending;
  }
}

export class Variants<T> {
  value: T | null = null;
  private readonly made = new Map<string, Lazy<T>>();

  load(key: string, make: () => Promise<T>): Promise<T> {
    let v = this.made.get(key);
    if (!v) this.made.set(key, (v = new Lazy(make)));
    return v.load();
  }

  get(key: string): T | null {
    return this.made.get(key)?.value ?? null;
  }

  use(key: string): T {
    const v = this.get(key);
    if (v === null) throw new GraphError("internal", `Pipeline variant ${key} is not loaded`);
    this.value = v;
    return v;
  }
}

export class Tuned<T> extends Variants<T> implements Tunable {
  constructor(
    private readonly key: (t: Tune) => string,
    private readonly make: (t: Tune) => Promise<T>,
  ) {
    super();
  }

  loadTune(t: Tune): Promise<unknown> {
    return this.load(this.key(t), () => this.make(t));
  }

  hasTune(t: Tune): boolean {
    return this.get(this.key(t)) !== null;
  }

  useTune(t: Tune): void {
    this.use(this.key(t));
  }
}
