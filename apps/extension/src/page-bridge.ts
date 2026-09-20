export function connectPageBridge(): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const candidates: MessagePort[] = [];
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    let settled = false;

    function attempt(): void {
      if (attempts++ === 8) {
        settled = true;
        for (const port of candidates) port.close();
        reject(new Error("Browser controller bridge did not respond. Reload the Xbox tab."));
        return;
      }
      const channel = new MessageChannel();
      const candidate = channel.port1;
      candidates.push(candidate);
      candidate.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (settled || typeof data !== "object" || data === null ||
          !("type" in data) || data.type !== "xib_bridge_ready_v1" ||
          !("nonce" in data) || data.nonce !== nonce) return;
        settled = true;
        clearTimeout(timer);
        for (const port of candidates) if (port !== candidate) port.close();
        resolve(candidate);
      });
      candidate.start();
      window.postMessage({ type: "xib_bridge_init_v1", nonce }, location.origin, [channel.port2]);
      // Keep earlier ports open: MAIN may have accepted one whose ACK is delayed.
      timer = setTimeout(attempt, 250);
    }

    attempt();
  });
}
