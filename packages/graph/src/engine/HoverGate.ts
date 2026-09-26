export class HoverGate {
  open = false;

  update(pickKinds: number, look: boolean, listening: boolean): number {
    const open = pickKinds !== 0 && (look || listening);
    if (open === this.open) return 0;
    this.open = open;
    return open ? 1 : -1;
  }
}
