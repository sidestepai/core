import { gzipSync } from "node:zlib";

/**
 * Build a gzipped ustar archive containing a single `workspace.json` — the shape
 * the workspace-export endpoint returns — so tests can exercise the decode +
 * round-trip paths without a live instance.
 */
export function buildWorkspaceArchive(bundle: unknown): Uint8Array {
  const content = Buffer.from(JSON.stringify(bundle), "utf8");
  const header = Buffer.alloc(512, 0);
  header.write("workspace.json", 0, "utf8");
  header.write("0000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size (octal)
  header.write("00000000000\0", 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // checksum placeholder: 8 spaces
  header.write("0", 156, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  const end = Buffer.alloc(1024, 0); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat([header, content, pad, end]));
}
