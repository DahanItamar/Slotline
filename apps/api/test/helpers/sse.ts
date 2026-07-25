/**
 * A minimal SSE client for the integration tests.
 *
 * `app.inject` buffers a whole response before returning, which is exactly what an
 * event stream never does — so these tests talk to a really listening server over real
 * HTTP. That also means they exercise the hijacked reply, the headers, and the framing,
 * which is where SSE actually goes wrong.
 */

export type SseFrame = {
  id?: string;
  event?: string;
  data?: string;
};

function parseBlock(block: string): SseFrame | null {
  const frame: SseFrame = {};
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // comment, e.g. the heartbeat
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();

    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') frame.data = value;
    else continue;
    sawField = true;
  }

  return sawField ? frame : null;
}

export class SseClient {
  readonly frames: SseFrame[] = [];
  readonly status: number;
  private readonly controller: AbortController;
  private readonly waiters: Array<() => void> = [];

  private constructor(status: number, controller: AbortController) {
    this.status = status;
    this.controller = controller;
  }

  static async open(baseUrl: string, cookie: string, lastEventId?: string): Promise<SseClient> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: {
        accept: 'text/event-stream',
        cookie,
        ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
      },
      signal: controller.signal,
    });

    const client = new SseClient(response.status, controller);
    if (response.status !== 200 || !response.body) {
      controller.abort();
      return client;
    }

    void client.consume(response.body);
    return client;
  }

  /** Consumes whole frames out of the buffer, returning whatever tail is left over. */
  private drain(buffer: string): string {
    let rest = buffer;
    let boundary = rest.indexOf('\n\n');

    while (boundary !== -1) {
      const frame = parseBlock(rest.slice(0, boundary));
      rest = rest.slice(boundary + 2);
      if (frame) this.record(frame);
      boundary = rest.indexOf('\n\n');
    }
    return rest;
  }

  private record(frame: SseFrame): void {
    this.frames.push(frame);
    for (const notify of this.waiters.splice(0)) notify();
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = this.drain(buffer + decoder.decode(value, { stream: true }));
      }
    } catch {
      // Aborted by close(), or the server went away. Either way there is nothing to do:
      // whatever arrived is already in `frames`.
    }
  }

  /** Resolves once a frame matching the predicate has arrived, or rejects on timeout. */
  async waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs = 5_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for a matching frame; saw: ${JSON.stringify(this.frames)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** Gives the stream a moment to deliver anything in flight. For negative assertions. */
  async settle(ms = 400): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  close(): void {
    this.controller.abort();
  }
}
