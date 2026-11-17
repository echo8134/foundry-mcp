type Listener = (event: any) => void;

export class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly url: string;
  binaryType = "blob";
  readonly sent: (string | Uint8Array)[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }

  emit(type: string, event: object = {}): void {
    if (type === "open") this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }
}
