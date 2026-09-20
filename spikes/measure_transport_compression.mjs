#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import process from "node:process";
import {
  constants,
  createBrotliCompress,
  createGzip,
} from "node:zlib";

function parseArguments(argv) {
  const groups = [];
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") {
      output = argv[++index];
      continue;
    }
    const separator = argv[index].indexOf("=");
    if (separator < 1) throw new Error(`Expected label=file[,file]: ${argv[index]}`);
    groups.push({
      label: argv[index].slice(0, separator),
      files: argv[index].slice(separator + 1).split(","),
    });
  }
  if (groups.length === 0) throw new Error("Provide at least one label=file[,file] group");
  return { groups, output };
}

async function compressedSize(file, transform) {
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  await pipeline(createReadStream(file), transform, sink);
  return bytes;
}

async function measure(files, factory) {
  const started = performance.now();
  let bytes = 0;
  for (const file of files) bytes += await compressedSize(file, factory());
  return { bytes, seconds: (performance.now() - started) / 1000 };
}

const { groups, output } = parseArguments(process.argv.slice(2));
const report = {
  generatedAt: new Date().toISOString(),
  settings: { gzipLevel: 6, brotliQuality: 5 },
  groups: {},
};

for (const group of groups) {
  const rawBytes = (await Promise.all(group.files.map(async (file) => (await stat(file)).size)))
    .reduce((sum, bytes) => sum + bytes, 0);
  const gzip = await measure(group.files, () => createGzip({ level: 6 }));
  const brotli = await measure(group.files, () => createBrotliCompress({
    params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
  }));
  report.groups[group.label] = {
    files: group.files,
    rawBytes,
    gzip: { ...gzip, ratio: gzip.bytes / rawBytes },
    brotli: { ...brotli, ratio: brotli.bytes / rawBytes },
  };
  console.error(`${group.label}: ${rawBytes} -> gzip ${gzip.bytes}, br ${brotli.bytes}`);
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, serialized);
process.stdout.write(serialized);
