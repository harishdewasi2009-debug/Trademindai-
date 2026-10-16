// utils/jsonArrayStream.js
// ══════════════════════════════════════════════════════════════════════════
//  Memory-safe reader for Upstox instrument-master files.
//
//  The official files are a single huge JSON array of flat objects,
//  gzip-compressed (complete.json.gz expands to well over 100MB). The old
//  approach (gunzipSync + JSON.parse) holds the whole thing in memory, which
//  already OOM-killed the 512MB Render instance once (see marketDataService
//  "runExclusive" notes). This scanner walks the decompressed byte stream
//  and emits ONE object at a time, so peak memory is a single chunk plus a
//  single row regardless of file size.
//
//  It understands JSON string quoting/escapes and nested braces/brackets, so
//  braces inside strings (e.g. a name containing "{") cannot confuse it.
// ══════════════════════════════════════════════════════════════════════════
const zlib = require('zlib');
const { Readable } = require('stream');

/**
 * Incremental scanner. Feed it string chunks via push(); it calls onObject()
 * with every complete top-level array element that is an object.
 */
class JsonArrayObjectScanner {
  constructor(onObject) {
    this.onObject = onObject;
    this.depth = 0;          // nesting depth inside the top-level array (0 = between elements)
    this.inString = false;
    this.escaped = false;
    this.buf = '';           // text of the object currently being assembled
    this.started = false;    // seen the opening '[' yet
    this.count = 0;
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (this.depth > 0) {
        this.buf += ch;
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (ch === '\\') this.escaped = true;
          else if (ch === '"') this.inString = false;
          continue;
        }
        if (ch === '"') { this.inString = true; continue; }
        if (ch === '{' || ch === '[') { this.depth++; continue; }
        if (ch === '}' || ch === ']') {
          this.depth--;
          if (this.depth === 0) {
            // One complete element — parse it and hand it off.
            let obj;
            try { obj = JSON.parse(this.buf); } catch { obj = null; }
            this.buf = '';
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              this.count++;
              this.onObject(obj);
            }
          }
        }
        continue;
      }

      // depth === 0: between elements
      if (!this.started) {
        if (ch === '[') this.started = true;
        continue;
      }
      if (ch === '{') { this.depth = 1; this.buf = '{'; }
      // commas / whitespace / the closing ']' of the outer array are ignored
    }
  }
}

/**
 * Streams a gzipped JSON array from a fetch() Response body and calls
 * `onBatch(rows)` with batches of at most `batchSize` parsed objects.
 * Awaiting onBatch applies backpressure (e.g. while inserting into Postgres).
 * Returns the total number of objects read.
 */
async function streamGzipJsonArray(readableOrWebStream, onBatch, { batchSize = 2000 } = {}) {
  const nodeReadable = typeof readableOrWebStream.pipe === 'function'
    ? readableOrWebStream
    : Readable.fromWeb(readableOrWebStream);

  const gunzip = zlib.createGunzip();
  nodeReadable.pipe(gunzip);
  nodeReadable.on('error', (e) => gunzip.destroy(e));
  gunzip.setEncoding('utf8');

  let batch = [];
  const scanner = new JsonArrayObjectScanner((obj) => { batch.push(obj); });
  let total = 0;

  for await (const chunk of gunzip) {
    scanner.push(chunk);
    while (batch.length >= batchSize) {
      const out = batch.splice(0, batchSize);
      total += out.length;
      await onBatch(out);
    }
  }
  if (batch.length) {
    total += batch.length;
    await onBatch(batch);
    batch = [];
  }
  return total;
}

module.exports = { JsonArrayObjectScanner, streamGzipJsonArray };
