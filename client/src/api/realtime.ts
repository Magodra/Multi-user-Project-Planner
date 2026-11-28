/** Live updates over WebSocket, with reconnect. Authenticates with the first message. */
import type { RealtimeClientMessage, RealtimeMessage } from "@planning/shared";
import { configError, webSocketUrl } from "../config";
import { getToken } from "./client";

type ChangeMessage = Extract<RealtimeMessage, { type: "changed" }>;
type Listener = (msg: ChangeMessage) => void;

export class RealtimeConnection {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private retry = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private readonly projectIds = new Set<string>();

  constructor(projectId: string) {
    this.projectIds.add(projectId);
    this.connect();
  }

  /** Also receive changes of another project (e.g. a subproject shown in this workspace). */
  watch(projectId: string): void {
    if (this.projectIds.has(projectId)) return;
    this.projectIds.add(projectId);
    if (this.ready) this.socket?.send(JSON.stringify({ type: "subscribe", projectId }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    const token = getToken();
    if (!token || this.closed || configError) return;
    const ws = new WebSocket(webSocketUrl());
    this.socket = ws;
    const send = (msg: RealtimeClientMessage) => ws.send(JSON.stringify(msg));
    ws.onopen = () => send({ type: "auth", token });
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as RealtimeMessage;
      if (msg.type === "ready") {
        this.retry = 0;
        this.ready = true;
        for (const projectId of this.projectIds) send({ type: "subscribe", projectId });
      } else if (msg.type === "changed") {
        for (const l of this.listeners) l(msg);
      }
    };
    ws.onclose = () => {
      this.ready = false;
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}
