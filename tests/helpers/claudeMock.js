'use strict';

// Replaces https.request for api.anthropic.com only, so tests never call the
// real Claude API. state.reply decides the answer for each call:
//   { status, body }   -> that HTTP response
//   'timeout'          -> never answers
//   'error'            -> connection error
//   function(request)  -> any of the above, from the parsed request body
// state.calls records { options, body } for every intercepted request.

const https = require('https');
const { EventEmitter } = require('events');

function installClaudeMock() {
  const original = https.request;
  const state = { calls: [], reply: null };
  https.request = function mockedRequest(options, callback) {
    if (!options || options.hostname !== 'api.anthropic.com') return original.apply(https, arguments);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
    };
    req.write = () => true;
    req.end = (data) => {
      const body = data ? data.toString('utf8') : '';
      state.calls.push({ options, body });
      const reply = typeof state.reply === 'function' ? state.reply(JSON.parse(body)) : state.reply;
      if (reply === 'timeout') return;
      if (reply === 'error') {
        setImmediate(() => req.emit('error', new Error('ECONNRESET')));
        return;
      }
      setImmediate(() => {
        if (req.destroyed) return;
        const res = new EventEmitter();
        res.statusCode = reply.status;
        callback(res);
        res.emit('data', Buffer.from(reply.body));
        res.emit('end');
      });
    };
    return req;
  };
  return {
    state,
    restore() {
      https.request = original;
    },
  };
}

/** A Messages API reply whose only text block is `text` (an object is sent as JSON). */
function modelReply(text, { stopReason = 'end_turn' } = {}) {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }],
      stop_reason: stopReason,
    }),
  };
}

/** A small valid-looking PDF in memory, with optional marker text inside. */
function fakePdf(marker = '') {
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${marker}\ntrailer << >>\n%%EOF\n`, 'latin1');
}

module.exports = { installClaudeMock, modelReply, fakePdf };
