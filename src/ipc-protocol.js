// NDJSON framing for the chatdump CLI <-> GUI IPC socket. Pure logic only --
// no electron, no net -- so this module can be required both from inside the
// GUI Electron process (ipc-server.js) and from the pure-node thin CLI
// client (ipc-client.js, cli-entry.js), which run under
// ELECTRON_RUN_AS_NODE and must not touch electron APIs.
//
// Message shapes:
//
// Client -> server
//   { type: 'request', id, cmd, args }
//
// Server -> client (all carry the same `id` as the request they answer)
//   { type: 'stdout', id, text }                          -- one line/blob of command output
//   { type: 'progress', id, state, message, accountId }    -- sync status update
//   { type: 'result', id, exitCode }                       -- stream done, success
//   { type: 'error', id, message, exitCode }                -- stream done, failure

// Encode a message object as a single NDJSON line (including the trailing
// newline that terminates it).
function encode(obj) {
  return `${JSON.stringify(obj)}\n`;
}

// Create a decoder that buffers arbitrary chunks of text and invokes
// `onMessage(obj)` once per complete NDJSON line, tolerating lines split
// across chunk boundaries. Returns an object with a single `push(chunk)`
// method; feed it every chunk read from the socket, in order.
function createLineDecoder(onMessage) {
  let buffer = '';

  function push(chunk) {
    buffer += chunk;

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onMessage(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }

  return { push };
}

module.exports = {
  encode,
  createLineDecoder,
};
