// The exif check in dev/site-checks.mjs: a JPEG with a GPS IFD fails the gate,
// a JPEG without one passes. The fixtures are hand-built byte by byte -- a
// checked-in photograph with GPS in it would be the very thing the check
// exists to keep out of the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SITE_CHECKS = fileURLToPath(new URL("../dev/site-checks.mjs", import.meta.url));

// A TIFF block (big-endian) with IFD0 holding the given entries, each
// [tag, type, count, value-or-offset], and an optional IFD1 built the same way.
function tiff(ifd0, ifd1 = null) {
  const ifdBytes = (entries, next) => {
    const b = Buffer.alloc(2 + 12 * entries.length + 4);
    b.writeUInt16BE(entries.length, 0);
    entries.forEach(([tag, type, count, value], k) => {
      const e = 2 + 12 * k;
      b.writeUInt16BE(tag, e); b.writeUInt16BE(type, e + 2);
      b.writeUInt32BE(count, e + 4); b.writeUInt32BE(value, e + 8);
    });
    b.writeUInt32BE(next, b.length - 4);
    return b;
  };
  const hdr = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  const first = ifdBytes(ifd0, ifd1 ? 8 + 2 + 12 * ifd0.length + 4 : 0);
  return ifd1 ? Buffer.concat([hdr, first, ifdBytes(ifd1, 0)]) : Buffer.concat([hdr, first]);
}

// Minimal JPEG: SOI, one APP1 Exif segment, EOI. Not decodable, and it does
// not need to be -- the check reads headers, never pixels.
function jpegWith(tiffBlock) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiffBlock]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xd9])]);
}

const GPS_IN_IFD0 = jpegWith(tiff([[0x8825, 4, 1, 26]]));           // GPSInfo -> (empty) GPS IFD
const GPS_IN_IFD1 = jpegWith(tiff([[0x0110, 2, 4, 0x41424300]], [[0x8825, 4, 1, 60]]));
const CLEAN_EXIF = jpegWith(tiff([[0x0110, 2, 4, 0x41424300], [0x8769, 4, 1, 26]]));
const NO_EXIF = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);

function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), "site-checks-exif-"));
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
    try {
      return { code: 0, out: execFileSync("node", [SITE_CHECKS, dir], { encoding: "utf8" }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a JPEG with a GPS IFD pointer in IFD0 fails the exif check", () => {
  const r = runOn({ "photo.jpeg": GPS_IN_IFD0 });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL {2}exif/);
  assert.match(r.out, /photo\.jpeg: carries a GPS IFD/);
});

test("a GPS IFD pointer hiding in IFD1 (the thumbnail) is found too", () => {
  const r = runOn({ "thumb.jpg": GPS_IN_IFD1 });
  assert.equal(r.code, 1);
  assert.match(r.out, /thumb\.jpg: carries a GPS IFD/);
});

test("JPEGs with other EXIF, no EXIF, or a non-JPEG extension pass", () => {
  const r = runOn({ "clean.jpeg": CLEAN_EXIF, "bare.jpg": NO_EXIF, "notes.txt": GPS_IN_IFD0 });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok {4}exif/);
});

test("a truncated or garbage .jpeg does not crash the gate", () => {
  const r = runOn({ "broken.jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]), "empty.jpg": Buffer.alloc(0) });
  assert.equal(r.code, 0, r.out);
});
