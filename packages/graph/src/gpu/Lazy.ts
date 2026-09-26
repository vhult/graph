import { GraphError } from "../api/errors";

export class Lazy<T> {
  value: T | null = null;
  private pending: Promise<T> | null = null;

  constructor(private readonly make: () => Promise<T>) {}

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
