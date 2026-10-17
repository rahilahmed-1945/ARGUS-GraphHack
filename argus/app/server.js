// Socket.IO delivery of the authoritative event stream (spec §2.2 argus-app: "React UI ◄─ Socket.IO ─ Orchestrator").
// No business logic here: the server forwards events from the bus, in order.
//   'event'                       every canonical event {seq, type, round, tick, payload}
//   'tick' | 'step' | 'future' | 'decision' | 'observation' | 'clock'   the spec §17.3 channels (same event objects)
//   on connect: 'state'           the current reduced state (bus.state()), for a (re)connecting client
//   'replay' (fromSeq, ack)       every event after fromSeq, so a client can fill a gap after reconnecting
import { createServer } from 'node:http';
import { Server } from 'socket.io';

export const CHANNELS = Object.freeze({
  WORLD_TICK: 'tick', TOOL_RESULT: 'step', FUTURE_EVALUATION_COMPLETED: 'future',
  DECISION_PROPOSED: 'decision', DECISION_AUDITED: 'decision', DECISION_COMMITTED: 'decision',
  WORLD_OBSERVATION: 'observation', CLOCK: 'clock',
});

export async function startEventServer({ bus, port = 0, host = '127.0.0.1' }) {
  const http = createServer((req, res) => {
    if (req.url === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(bus.state())); return; }
    res.writeHead(404); res.end();
  });
  const io = new Server(http, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    socket.emit('state', bus.state());
    socket.on('replay', (fromSeq, ack) => { if (typeof ack === 'function') ack(bus.since(Number(fromSeq) || 0)); });
  });
  const unsubscribe = bus.subscribe((ev) => {
    io.emit('event', ev);
    if (CHANNELS[ev.type]) io.emit(CHANNELS[ev.type], ev);
  });
  await new Promise((resolve) => http.listen(port, host, resolve));
  const { port: bound } = http.address();
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    async close() { unsubscribe(); await new Promise((r) => io.close(() => r())); },
  };
}
