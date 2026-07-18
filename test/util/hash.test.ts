import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { md5Hex, sha1Bytes, randomBytes } from "../../src/util/hash.js";

/**
 * The pure-JS hashes back object identity (md5 guids) and the golden bundle
 * signature (sha1). They MUST stay byte-for-byte identical to `node:crypto` —
 * any drift silently changes every guid and breaks import signatures. Fuzzed
 * against `node:crypto` so a regression can't slip through.
 */
const b64websafe = (u: Uint8Array) =>
  Buffer.from(u).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");

describe("pure-JS md5/sha1 vs node:crypto", () => {
  const fixed = [
    "",
    "a",
    "abc",
    "message digest",
    "The quick brown fox jumps over the lazy dog",
    "query:auth/signup",
    "dbo:user",
    "app:twitter",
    "ünïcödé 🚀 日本語",
    "a".repeat(55), // block-boundary cases for both algorithms
    "a".repeat(56),
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "a".repeat(1000),
  ];

  it.each(fixed)("md5(%j) matches createHash", (input) => {
    expect(md5Hex(input)).toBe(createHash("md5").update(input).digest("hex"));
  });

  it.each(fixed)("sha1(%j) matches createHash", (input) => {
    expect(b64websafe(sha1Bytes(input))).toBe(
      b64websafe(createHash("sha1").update(input).digest()),
    );
  });

  it("agrees with node:crypto across randomized fuzz inputs", () => {
    let md5Fail = 0;
    let sha1Fail = 0;
    for (let i = 0; i < 1500; i++) {
      const n = Math.floor(Math.random() * 260);
      let s = "";
      for (let j = 0; j < n; j++) s += String.fromCharCode(Math.floor(Math.random() * 320));
      if (md5Hex(s) !== createHash("md5").update(s).digest("hex")) md5Fail++;
      if (b64websafe(sha1Bytes(s)) !== b64websafe(createHash("sha1").update(s).digest())) sha1Fail++;
    }
    expect({ md5Fail, sha1Fail }).toEqual({ md5Fail: 0, sha1Fail: 0 });
  });

  it("randomBytes returns the requested length and varies", () => {
    expect(randomBytes(6)).toHaveLength(6);
    expect(Buffer.from(randomBytes(16)).toString("hex")).not.toBe(
      Buffer.from(randomBytes(16)).toString("hex"),
    );
  });
});
