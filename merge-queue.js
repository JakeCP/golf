#!/usr/bin/env node
// Merge the remote booking queue with the local post-run queue and print the
// result to stdout. Used by entrypoint.sh when pushing queue state back: the
// frontend may have added or deleted requests on GitHub while a booking run
// was in flight, so the bot's commit is rebuilt on top of the latest remote
// state instead of clobbering it (or being rejected as non-fast-forward).
//
// Usage: node merge-queue.js <remote-queue.json> <local-queue.json>
//
// Semantics:
// - Requests this run processed (present in local processedRequests) are
//   removed from bookingRequests regardless of what the remote says.
// - Everything else in the remote bookingRequests wins, so additions and
//   deletions made from the frontend during the run are preserved.
// - processedRequests is the local list (newest first) plus any remote-only
//   entries.

const fs = require("fs");

function readQueue(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    bookingRequests: Array.isArray(data.bookingRequests)
      ? data.bookingRequests
      : [],
    processedRequests: Array.isArray(data.processedRequests)
      ? data.processedRequests
      : [],
  };
}

function mergeQueues(remote, local) {
  const processedIds = new Set(local.processedRequests.map((r) => r.id));
  return {
    bookingRequests: remote.bookingRequests.filter(
      (r) => !processedIds.has(r.id)
    ),
    processedRequests: [
      ...local.processedRequests,
      ...remote.processedRequests.filter((r) => !processedIds.has(r.id)),
    ],
  };
}

function main() {
  const [remoteFile, localFile] = process.argv.slice(2);
  if (!remoteFile || !localFile) {
    console.error(
      "Usage: node merge-queue.js <remote-queue.json> <local-queue.json>"
    );
    process.exit(1);
  }

  const local = readQueue(localFile);

  let remote;
  try {
    remote = readQueue(remoteFile);
  } catch (err) {
    // Unreadable remote queue: fall back to the local state wholesale rather
    // than losing the run's results.
    console.error(
      `merge-queue: could not read remote queue (${err.message}); using local state`
    );
    process.stdout.write(JSON.stringify(local, null, 2));
    return;
  }

  process.stdout.write(JSON.stringify(mergeQueues(remote, local), null, 2));
}

main();
