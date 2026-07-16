import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

await import("../public/archives.js");

const { listEntries } = globalThis.LogArchives;
const encoder = new TextEncoder();

function storedZip(name, text) {
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(text);
  const local = new Uint8Array(30 + nameBytes.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(data, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);
  return new Blob([local, central, end]);
}

function tarArchive(name, text) {
  const data = encoder.encode(text);
  const header = new Uint8Array(512);
  const write = (offset, length, value) => {
    header.set(encoder.encode(value).subarray(0, length), offset);
  };
  write(0, 100, name);
  write(100, 8, "0000644\0");
  write(108, 8, "0000000\0");
  write(116, 8, "0000000\0");
  write(124, 12, `${data.length.toString(8).padStart(11, "0")}\0`);
  write(136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  write(257, 6, "ustar\0");
  write(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);

  const paddedSize = Math.ceil(data.length / 512) * 512;
  const tar = new Uint8Array(512 + paddedSize + 1024);
  tar.set(header);
  tar.set(data, 512);
  return tar;
}

test("lists ZIP contents for browsing before extraction", async () => {
  const archive = storedZip("logs/app.log", "ERROR example\n");
  const listing = await listEntries(archive, "bundle.zip");

  assert.deepEqual(listing.entries, [
    { path: "bundle.zip/logs/app.log", size: 14 },
  ]);
  assert.deepEqual(listing.skipped, []);
  assert.deepEqual(listing.errors, []);
});

test("streams a compressed TAR manifest without retaining file contents", async () => {
  const tar = tarArchive("logs/app.log", "ERROR example\n");
  const archive = new Blob([gzipSync(tar)]);
  const listing = await listEntries(archive, "bundle.tgz");

  assert.deepEqual(listing.entries, [
    { path: "bundle.tgz/logs/app.log", size: 14 },
  ]);
  assert.deepEqual(listing.skipped, []);
  assert.deepEqual(listing.errors, []);
});
