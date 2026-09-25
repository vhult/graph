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
