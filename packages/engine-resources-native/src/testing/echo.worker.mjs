// A worker of the tests: the protocol of serveWorker, in plain JavaScript
// (the TypeScript sources of the packages do not run in a bare worker).
import { parentPort } from 'node:worker_threads';

parentPort.on('message', async ({ id, payload }) => {
  if (payload.fail) {
    parentPort.postMessage({
      id,
      error: { name: 'Error', message: payload.fail },
    });
    return;
  }
  if (payload.delay) await new Promise((r) => setTimeout(r, payload.delay));
  if (payload.crash) process.exit(1);
  const bytes = payload.bytes;
  parentPort.postMessage(
    { id, result: { length: bytes?.length ?? 0, echo: payload.echo } },
    []
  );
});
