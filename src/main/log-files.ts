import fs from "node:fs";

// The desktop's logs (the device world, the share tunnel, the local AI
// engines) used to be appended to forever. Each is rotated when it is
// opened for a run: past MAX_LOG_BYTES the file moves to "<name>.1",
// replacing the one before, and the run starts a fresh file. So a log holds
// at most the current run and one older file, the same idea as the Android
// app's LogFiles. A child process writes straight into its file, so a run
// is not cut part way; the next start rotates it.
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function rotateLog(file: string, max = MAX_LOG_BYTES): void {
  try {
    if (fs.statSync(file).size <= max) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Missing (a first run) or unreadable: the open that follows decides.
  }
}

// A log file descriptor for a child process to append to, rotated first.
export function openLog(file: string, max = MAX_LOG_BYTES): number {
  rotateLog(file, max);
  return fs.openSync(file, "a");
}
