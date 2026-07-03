// Client-side archive expansion for Log Search.
//
// Everything runs in the browser -- nothing is ever uploaded. We read only the
// bytes we need from each archive (via Blob.slice for ZIP, or a streaming pass
// for TAR) and decompress with the native DecompressionStream API, then hand
// each inner file to a "sink" that the scanner drives line by line.
//
// Supported containers: .zip, .tar, .tar.gz / .tgz, and single-file .gz.
//
// The sink interface (implemented by the caller):
//   open(name, sizeHint)      -> handle (or null to ignore this file's bytes)
//   chunk(handle, uint8Array) -> boolean (return false to stop receiving)
//   close(handle)
//   skip(name, reason)        -> entry exists but cannot be read (encrypted, ...)
//   error(archivePath, err)   -> the whole archive could not be parsed
(function (root) {
  "use strict";

  const utf8 = new TextDecoder("utf-8", { fatal: false });

  const ZIP_EOCD_SIG = 0x06054b50; // End Of Central Directory
  const ZIP_EOCD64_SIG = 0x06064b50; // ZIP64 End Of Central Directory
  const ZIP_EOCD64_LOC_SIG = 0x07064b50; // ZIP64 EOCD locator
  const ZIP_CDH_SIG = 0x02014b50; // Central Directory file Header
  const ZIP_LFH_SIG = 0x04034b50; // Local File Header
  const U32_MAX = 0xffffffff;
  const CHUNK = 1 << 16; // 64 KiB streaming window

  // ---- format detection ---------------------------------------------------

  function archiveKind(name) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".zip")) return "zip";
    if (n.endsWith(".tar.gz") || n.endsWith(".tgz")) return "targz";
    if (n.endsWith(".tar")) return "tar";
    if (n.endsWith(".gz") || n.endsWith(".gzip")) return "gzip";
    return null;
  }

  function support() {
    let deflateRaw = false;
    let gzip = false;
    try {
      // eslint-disable-next-line no-new
      new DecompressionStream("deflate-raw");
      deflateRaw = true;
    } catch (e) {}
    try {
      // eslint-disable-next-line no-new
      new DecompressionStream("gzip");
      gzip = true;
    } catch (e) {}
    return { deflateRaw, gzip, any: deflateRaw || gzip };
  }

  function canExpand(name) {
    const kind = archiveKind(name);
    if (!kind) return false;
    // Stored ZIP entries and plain TAR need no codec; DEFLATE entries are
    // guarded per-entry at open time. gzip / tar.gz / tgz need gzip support.
    if (kind === "zip" || kind === "tar") return true;
    return support().gzip;
  }

  // ---- little helpers ------------------------------------------------------

  function joinPath(base, name) {
    const clean = String(name).replace(/^\/+/, "");
    return base ? base + "/" + clean : clean;
  }

  function readUint64LE(dv, off) {
    const lo = dv.getUint32(off, true);
    const hi = dv.getUint32(off + 4, true);
    return hi * 0x100000000 + lo; // safe for sizes below 2^53
  }

  function cstr(u8, off, len) {
    let end = off;
    const limit = off + len;
    while (end < limit && u8[end] !== 0) end++;
    return utf8.decode(u8.subarray(off, end));
  }

  // ---- ZIP -----------------------------------------------------------------

  async function sliceBytes(file, start, end) {
    const clampedStart = Math.max(0, Math.min(start, file.size));
    const clampedEnd = Math.max(clampedStart, Math.min(end, file.size));
    return new Uint8Array(await file.slice(clampedStart, clampedEnd).arrayBuffer());
  }

  // Parse the central directory and return a list of entry descriptors.
  async function readZipEntries(file) {
    const size = file.size;
    if (size < 22) throw new Error("File is too small to be a ZIP archive");

    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await sliceBytes(file, size - tailLen, size);
    const tdv = new DataView(tail.buffer);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tdv.getUint32(i, true) === ZIP_EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error("Not a ZIP archive (no end-of-central-directory)");

    let cdCount = tdv.getUint16(eocd + 10, true);
    let cdSize = tdv.getUint32(eocd + 12, true);
    let cdOffset = tdv.getUint32(eocd + 16, true);

    // ZIP64: values overflowed the 32-bit fields, so read the real ones.
    if (cdOffset === U32_MAX || cdSize === U32_MAX || cdCount === 0xffff) {
      const locPos = eocd - 20;
      if (locPos >= 0 && tdv.getUint32(locPos, true) === ZIP_EOCD64_LOC_SIG) {
        const rec64Off = readUint64LE(tdv, locPos + 8);
        const rec = await sliceBytes(file, rec64Off, rec64Off + 56);
        const rdv = new DataView(rec.buffer);
        if (rec.length >= 56 && rdv.getUint32(0, true) === ZIP_EOCD64_SIG) {
          cdCount = readUint64LE(rdv, 32);
          cdSize = readUint64LE(rdv, 40);
          cdOffset = readUint64LE(rdv, 48);
        }
      }
    }

    const cd = await sliceBytes(file, cdOffset, cdOffset + cdSize);
    const cdv = new DataView(cd.buffer);
    const entries = [];
    let p = 0;
    for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
      if (cdv.getUint32(p, true) !== ZIP_CDH_SIG) break;
      const flag = cdv.getUint16(p + 8, true);
      const method = cdv.getUint16(p + 10, true);
      let compSize = cdv.getUint32(p + 20, true);
      let uncompSize = cdv.getUint32(p + 24, true);
      const nameLen = cdv.getUint16(p + 28, true);
      const extraLen = cdv.getUint16(p + 30, true);
      const commentLen = cdv.getUint16(p + 32, true);
      let localOffset = cdv.getUint32(p + 42, true);
      const name = decodeEntryName(cd.subarray(p + 46, p + 46 + nameLen), flag);

      if (compSize === U32_MAX || uncompSize === U32_MAX || localOffset === U32_MAX) {
        const z = readZip64Extra(cd, p + 46 + nameLen, extraLen, {
          uncompSize,
          compSize,
          localOffset,
        });
        uncompSize = z.uncompSize;
        compSize = z.compSize;
        localOffset = z.localOffset;
      }

      entries.push({
        name,
        method,
        compSize,
        uncompSize,
        localOffset,
        isDir: name.endsWith("/"),
        encrypted: (flag & 0x1) !== 0,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function decodeEntryName(bytes, flag) {
    // Bit 11 signals UTF-8; otherwise names are technically CP437, but ASCII
    // (the overwhelmingly common case for logs) decodes identically as UTF-8.
    return utf8.decode(bytes);
  }

  function readZip64Extra(buf, start, len, cur) {
    const out = {
      uncompSize: cur.uncompSize,
      compSize: cur.compSize,
      localOffset: cur.localOffset,
    };
    const dv = new DataView(buf.buffer, buf.byteOffset + start, len);
    let o = 0;
    while (o + 4 <= len) {
      const id = dv.getUint16(o, true);
      const sz = dv.getUint16(o + 2, true);
      if (id === 0x0001) {
        let q = o + 4;
        if (out.uncompSize === U32_MAX) {
          out.uncompSize = readUint64LE(dv, q);
          q += 8;
        }
        if (out.compSize === U32_MAX) {
          out.compSize = readUint64LE(dv, q);
          q += 8;
        }
        if (out.localOffset === U32_MAX) {
          out.localOffset = readUint64LE(dv, q);
          q += 8;
        }
        break;
      }
      o += 4 + sz;
    }
    return out;
  }

  // Turn a single ZIP entry into a stream of decompressed bytes.
  async function openZipEntry(file, entry) {
    if (entry.encrypted) return { unsupported: "encrypted" };
    if (entry.method !== 0 && entry.method !== 8) {
      return { unsupported: "compression method " + entry.method };
    }
    const head = await sliceBytes(file, entry.localOffset, entry.localOffset + 30);
    const hdv = new DataView(head.buffer);
    if (head.length < 30 || hdv.getUint32(0, true) !== ZIP_LFH_SIG) {
      return { unsupported: "bad local header" };
    }
    const nameLen = hdv.getUint16(26, true);
    const extraLen = hdv.getUint16(28, true);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compSize;
    let stream = file.slice(dataStart, dataEnd).stream();
    if (entry.method === 8) {
      try {
        stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
      } catch (e) {
        return { unsupported: "deflate unsupported by this browser" };
      }
    }
    return { stream };
  }

  async function extractZip(file, path, sink, opts) {
    let entries;
    try {
      entries = await readZipEntries(file);
    } catch (e) {
      sink.error(path, e);
      return;
    }
    for (const entry of entries) {
      if (opts.isCancelled && opts.isCancelled()) break;
      if (entry.isDir) continue;
      const full = joinPath(path, entry.name);
      let opened;
      try {
        opened = await openZipEntry(file, entry);
      } catch (e) {
        sink.skip(full, e.message || "unreadable");
        continue;
      }
      if (opened.unsupported) {
        sink.skip(full, opened.unsupported);
        continue;
      }
      await pumpStream(opened.stream, full, entry.uncompSize, sink, opts);
    }
  }

  // ---- GZIP (single file) --------------------------------------------------

  async function extractGzip(file, path, sink, opts) {
    const inner = path.replace(/\.(gz|gzip)$/i, "") || path;
    let stream;
    try {
      stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    } catch (e) {
      sink.error(path, e);
      return;
    }
    await pumpStream(stream, inner, 0, sink, opts);
  }

  // Read a byte stream fully into the sink for one inner file.
  async function pumpStream(stream, name, sizeHint, sink, opts) {
    const handle = sink.open(name, sizeHint || 0);
    const reader = stream.getReader();
    let receiving = handle != null;
    try {
      while (receiving) {
        if (opts.isCancelled && opts.isCancelled()) {
          await reader.cancel();
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length && sink.chunk(handle, value) === false) {
          await reader.cancel();
          break;
        }
      }
    } catch (e) {
      // A corrupt/truncated stream shouldn't abort the whole run.
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
    }
    if (handle != null) sink.close(handle);
  }

  // ---- TAR (streaming, optionally through gzip) ----------------------------

  // Pull-based byte reader that hands out contiguous slices on demand while
  // keeping only a small amount buffered.
  function byteSource(readable) {
    const reader = readable.getReader();
    let chunks = [];
    let queued = 0;
    let ended = false;

    async function pull() {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      if (value && value.length) {
        chunks.push(value);
        queued += value.length;
      }
    }

    return {
      get exhausted() {
        return ended && queued === 0;
      },
      async ensure(n) {
        while (queued < n && !ended) await pull();
        return queued >= n;
      },
      // Return up to n bytes as one contiguous Uint8Array.
      async take(n) {
        await this.ensure(n);
        const want = Math.min(n, queued);
        if (want === 0) return new Uint8Array(0);
        const first = chunks[0];
        if (first.length >= want) {
          const out = first.subarray(0, want);
          if (first.length === want) chunks.shift();
          else chunks[0] = first.subarray(want);
          queued -= want;
          return out;
        }
        const out = new Uint8Array(want);
        let filled = 0;
        while (filled < want) {
          const c = chunks[0];
          const need = want - filled;
          if (c.length <= need) {
            out.set(c, filled);
            filled += c.length;
            chunks.shift();
          } else {
            out.set(c.subarray(0, need), filled);
            chunks[0] = c.subarray(need);
            filled += need;
          }
        }
        queued -= want;
        return out;
      },
      async cancel() {
        try {
          await reader.cancel();
        } catch (e) {}
      },
    };
  }

  function isAllZero(u8) {
    for (let i = 0; i < u8.length; i++) if (u8[i] !== 0) return false;
    return true;
  }

  function tarSize(u8, off, len) {
    // GNU may store large sizes as base-256 (high bit set on the first byte).
    if (u8[off] & 0x80) {
      let n = u8[off] & 0x7f;
      for (let i = 1; i < len; i++) n = n * 256 + u8[off + i];
      return n;
    }
    let s = "";
    for (let i = 0; i < len; i++) {
      const c = u8[off + i];
      if (c === 0 || c === 32) break;
      s += String.fromCharCode(c);
    }
    const n = parseInt(s, 8);
    return Number.isFinite(n) ? n : 0;
  }

  function tarChecksumOk(h) {
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < 512; i++) {
      const c = i >= 148 && i < 156 ? 32 : h[i];
      unsigned += c;
      signed += (c << 24) >> 24;
    }
    const storedStr = cstr(h, 148, 8).trim();
    const stored = parseInt(storedStr, 8);
    if (!Number.isFinite(stored)) return false;
    return stored === unsigned || stored === signed;
  }

  function paxPath(payloadU8) {
    // pax records look like: "<len> key=value\n". We only care about "path".
    const text = utf8.decode(payloadU8);
    const re = /\d+ ([^=]+)=([^\n]*)\n/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] === "path") return m[2];
    }
    return null;
  }

  async function copyBytes(src, n, onChunk, opts) {
    let remaining = n;
    while (remaining > 0) {
      if (opts.isCancelled && opts.isCancelled()) break;
      const piece = await src.take(Math.min(remaining, CHUNK));
      if (piece.length === 0) break; // truncated archive
      onChunk(piece);
      remaining -= piece.length;
    }
    return n - remaining;
  }

  async function extractTarStream(byteStream, path, sink, opts) {
    const src = byteSource(byteStream);
    let longName = null;
    try {
      while (true) {
        if (opts.isCancelled && opts.isCancelled()) break;
        const header = await src.take(512);
        if (header.length < 512) break; // clean or truncated end
        if (isAllZero(header)) break; // end-of-archive marker
        if (!tarChecksumOk(header)) break; // garbage / not a tar boundary

        const size = tarSize(header, 124, 12);
        const typeflag = String.fromCharCode(header[156]) || "\0";
        const dataBlocks = Math.ceil(size / 512);
        const pad = dataBlocks * 512 - size;

        let name = cstr(header, 0, 100);
        const prefix = cstr(header, 345, 155);
        const magic = cstr(header, 257, 6);
        if (prefix && magic.indexOf("ustar") === 0) name = prefix + "/" + name;
        if (longName) {
          name = longName;
          longName = null;
        }

        if (typeflag === "L") {
          // GNU long name: payload is the real name of the *next* entry.
          const nameBytes = await src.take(size);
          longName = utf8.decode(nameBytes).replace(/\0+$/, "");
          if (pad) await src.take(pad);
          continue;
        }
        if (typeflag === "x" || typeflag === "g" || typeflag === "K") {
          const payload = await src.take(size);
          if (pad) await src.take(pad);
          if (typeflag === "x" || typeflag === "K") {
            const p = paxPath(payload);
            if (p) longName = p;
          }
          continue;
        }

        const isFile = typeflag === "0" || typeflag === "\0" || typeflag === "7";
        if (!isFile) {
          // directory / symlink / device: no scannable payload
          if (size) await copyBytes(src, size, function () {}, opts);
          if (pad) await src.take(pad);
          continue;
        }

        const full = joinPath(path, name.replace(/\/+$/, ""));
        const handle = sink.open(full, size);
        let receiving = handle != null;
        const read = await copyBytes(
          src,
          size,
          function (chunk) {
            if (receiving && sink.chunk(handle, chunk) === false) receiving = false;
          },
          opts
        );
        if (handle != null) sink.close(handle);
        if (pad) await src.take(pad);
        if (read < size) break; // truncated
      }
    } catch (e) {
      sink.error(path, e);
    } finally {
      await src.cancel();
    }
  }

  async function extractTar(file, path, sink, opts, gzipped) {
    let stream;
    try {
      stream = file.stream();
      if (gzipped) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    } catch (e) {
      sink.error(path, e);
      return;
    }
    await extractTarStream(stream, path, sink, opts);
  }

  // ---- dispatch ------------------------------------------------------------

  async function extract(file, path, sink, opts) {
    const options = opts || {};
    const kind = archiveKind(path);
    try {
      if (kind === "zip") return await extractZip(file, path, sink, options);
      if (kind === "gzip") return await extractGzip(file, path, sink, options);
      if (kind === "tar") return await extractTar(file, path, sink, options, false);
      if (kind === "targz") return await extractTar(file, path, sink, options, true);
    } catch (e) {
      sink.error(path, e);
    }
  }

  root.LogArchives = {
    archiveKind,
    support,
    canExpand,
    extract,
    // exposed for tests:
    readZipEntries,
    openZipEntry,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
