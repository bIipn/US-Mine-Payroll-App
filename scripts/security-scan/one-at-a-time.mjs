// One scanner at a time. A scan or rescan is refused while another hawk command runs, but a hawk
// command that has just been told to stop (validate's last step stops the scanning engine) can
// take a few seconds to leave. So it is looked for again, a second apart, before a scan is refused.

/**
 * The process ids of a hawk command still running after `tries` looks, or '' once none is.
 * `find` returns the ids it sees as text, '' for none.
 */
export async function otherScannerStill(find, { tries = 15, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let seen = '';
  for (let look = 0; look < tries; look += 1) {
    seen = find().trim();
    if (!seen) return '';
    if (look < tries - 1) await sleep(1000);
  }
  return seen;
}
