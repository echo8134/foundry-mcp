import { setTimeout as delay } from "node:timers/promises";
import type { BridgeInfo } from "./protocol.ts";

type Client = { userId: string; close: () => Promise<void> };

export type AutomaticClientOptions = {
  user: string;
  launch: (options: { port: number; signal: AbortSignal }) => Promise<Client>;
  graceMs?: number;
  startupTimeoutMs?: number;
};

type Attempt = {
  controller: AbortController;
  deadline: NodeJS.Timeout;
  launch: Promise<Client>;
  phase: { kind: "grace" } | { kind: "joining" } | { kind: "joined"; userId: string };
};

export class AutomaticClient {
  private readonly options: AutomaticClientOptions;
  private readonly connected: () => BridgeInfo | null;
  private readonly log: (message: string) => void;
  private readonly waiting = new Set<(error?: Error) => void>();
  private attempt: Attempt | null = null;
  private closing = Promise.resolve();

  constructor(options: AutomaticClientOptions, connected: () => BridgeInfo | null, log: (message: string) => void) {
    this.options = options;
    this.connected = connected;
    this.log = log;
  }

  waitForBridge(port: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.waiting.delete(finish);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        finish(new Error("The Foundry tool call was cancelled."));
        if (this.waiting.size === 0) this.release();
      };
      this.waiting.add(finish);
      signal?.addEventListener("abort", cancel, { once: true });
      if (!this.attempt) this.start(port);
    });
  }

  bridgeReady(): void {
    const user = this.connected()?.user;
    if (!user) return;
    for (const finish of this.waiting) finish();
    const attempt = this.attempt;
    if (!attempt) return;
    const phase = attempt.phase;
    if (phase.kind === "joined" && phase.userId === user.id) {
      clearTimeout(attempt.deadline);
    } else if (phase.kind !== "joining" || user.name !== this.options.user) {
      this.release();
    }
  }

  release(error?: Error): Promise<void> {
    for (const finish of this.waiting) finish(error);
    const attempt = this.attempt;
    if (attempt) {
      this.attempt = null;
      clearTimeout(attempt.deadline);
      attempt.controller.abort();
      // A cancelled join can still return a browser. Finish closing it before starting another login.
      this.closing = attempt.launch
        .then(
          (client) => client.close(),
          () => {}
        )
        .catch(() => this.log("could not close the automatic Foundry client"));
    }
    return this.closing;
  }

  private start(port: number): void {
    const controller = new AbortController();
    const { signal } = controller;
    const launch = this.closing.then(async () => {
      signal.throwIfAborted();
      await delay(this.options.graceMs ?? 1500, undefined, { signal });
      signal.throwIfAborted();
      attempt.phase = { kind: "joining" };
      return this.options.launch({ port, signal });
    });
    const attempt: Attempt = {
      controller,
      phase: { kind: "grace" },
      launch,
      deadline: setTimeout(() => {
        this.release(new Error("The automatic Foundry client timed out waiting for an authenticated bridge."));
      }, this.options.startupTimeoutMs ?? 45_000)
    };
    this.attempt = attempt;
    launch.then(
      (client) => {
        if (this.attempt !== attempt) return;
        attempt.phase = { kind: "joined", userId: client.userId };
        this.bridgeReady();
      },
      (error: unknown) => {
        if (this.attempt === attempt) this.release(error instanceof Error ? error : new Error("Foundry login failed."));
      }
    );
  }
}
