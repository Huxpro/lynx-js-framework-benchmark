import { COMPARISON, ENTRIES, GENERATED_AT, MACHINES } from '../data';

export function MethodPage() {
  return (
    <>
      <div className="card">
        <div className="card-title">source data vs derived data</div>
        <div className="card-desc" style={{ maxWidth: '80ch' }}>
          <p>
            <b>Benchmark source</b> is limited to run/environment identity, record identity,
            raw repeated <code>samples</code>, one-shot <code>value</code>, <code>dnfCount</code>,
            and per-repetition wire <code>detailSamples</code>. Entry manifests and their checked
            bundles are build source.
          </p>
          <p>
            <b>Everything else is derived:</b> median/mean/CI, endpoint display samples, cohort and
            Lab calibration, available entries/cases/scales, rankings, interactive scores,
            geomeans, ratios, trend α, axes, totals, sorting, and every visual mark. The site build
            regenerates <code>results/latest.json</code> from source before loading it; stored
            aggregate fields in historical run files are ignored and recomputed.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">how the numbers are made</div>
        <div className="card-desc" style={{ maxWidth: '80ch' }}>
          <p>
            Every entry is the same krausest-style table app, implemented idiomatically per
            framework, driven by one byte-identical page instrument in headless Chromium running
            Lynx for Web. Timing is <b>in-page pointerdown → the first animation frame where a
            composed-DOM predicate holds</b> — real input, shadow-piercing verification, ≤1 frame
            quantization. Startup is <b>view-attach → first table content</b> on bundles whose
            first screen pre-renders N rows.
          </p>
          <p>
            Dual-thread metrics come from two framework-neutral instruments: a{' '}
            <b>wire meter</b> patched over the MessageChannel that carries every BTS↔MTS rpc
            message on Lynx for Web (both directions, per-endpoint, bytes as UTF-8 JSON
            serialization — a structured-clone proxy applied identically to all entries), and{' '}
            <b>per-realm CPU sampling</b> via the Chrome DevTools Profiler attached separately to
            the UI thread and the background worker.
          </p>
          <p>
            Fairness: seeded PRNG in both realms (identical row data everywhere), <code>window.gc()</code>{' '}
            before timed samples, web-core's unbounded <code>lynx.profile</code> shim neutralized for
            every entry (native parity), medians with t-distribution CI, DNFs reported — never
            silently dropped.
          </p>
          <p>
            The <b>web harness is not a native device</b>. Numbers here are Lynx-for-Web-in-Chromium;
            they expose architectural behavior (wire cost, thread split, scaling shape), not native
            absolute performance. The schema, the runner, and every entry's{' '}
            <code>main.lynx.bundle</code> reserve a separate <code>native</code> harness whose numbers,
            when wired to a device adapter, will never be charted against web numbers.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">machines &amp; calibration</div>
        <div className="card-desc">
          Every featured chart is sourced from one coherent run: <code>{COMPARISON.runFile}</code> on machine{' '}
          <code>{COMPARISON.machineId}</code>, preflight score {COMPARISON.calibration.score} (v
          {COMPARISON.calibration.probeVersion}). The collector keeps partial and cross-machine
          records for provenance, but never merges them into the default ranking. Opt-in Lab
          variants marked <b>≈ calibrated</b> come from one complete historical run per entry;
          millisecond fields are multiplied by source-score / comparison-score. Heap, wire, bundle,
          and count fields cannot be CPU-calibrated and remain explicitly historical values.
        </div>
        <details className="data-table" open>
          <summary>Machines in this dataset</summary>
          <table>
            <thead>
              <tr><th>machine</th><th>cpu</th><th>cores</th><th>node</th><th>latest preflight</th></tr>
            </thead>
            <tbody>
              {Object.values(MACHINES).map((m) => (
                <tr key={m.id}>
                  <td>{m.id}</td>
                  <td style={{ textAlign: 'left' }}>{m.cpuModel} ({m.platform}/{m.arch})</td>
                  <td>{m.cores}</td>
                  <td>{m.node}</td>
                  <td>{m.latestCalibration?.score ?? '—'} (v{m.latestCalibration?.probeVersion ?? '?'})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {COMPARISON.labEstimates.length > 0 && (
          <details className="data-table">
            <summary>Calibration-only Lab sources</summary>
            <table>
              <thead>
                <tr><th>entry</th><th>source run</th><th>source score</th><th>target score</th><th>ratio</th></tr>
              </thead>
              <tbody>
                {COMPARISON.labEstimates.map((estimate) => (
                  <tr key={estimate.entryId}>
                    <td>{estimate.entryId}</td>
                    <td style={{ textAlign: 'left' }}>{estimate.sourceRunFile}</td>
                    <td>{estimate.sourceCalibration.score}</td>
                    <td>{estimate.targetCalibration.score}</td>
                    <td>{estimate.calibrationRatio?.toFixed(4) ?? 'incompatible'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        <div className="note">newest source run {new Date(GENERATED_AT).toLocaleString()}</div>
      </div>

      <div className="card">
        <div className="card-title">entries &amp; provenance</div>
        <div className="card-desc">
          Vendored bundles carry source repo, commit, build command, and sha256 checksums; add an
          entry by adding <code>entries/&lt;id&gt;/</code> with an <code>entry.json</code> — nothing else changes.
        </div>
        <details className="data-table provenance" open>
          <summary>Entry table</summary>
          <table>
            <thead>
              <tr><th>entry</th><th>framework</th><th>config</th><th>source</th><th>commit</th></tr>
            </thead>
            <tbody>
              {ENTRIES.map((e) => (
                <tr key={e.id}>
                  <td style={{ textAlign: 'left' }}>{e.label}</td>
                  <td style={{ textAlign: 'left' }}>{e.framework} {e.frameworkVersion}</td>
                  <td style={{ textAlign: 'left' }}>{e.config}</td>
                  <td style={{ textAlign: 'left' }}>
                    <a href={e.provenance.source} target="_blank" rel="noreferrer">
                      {e.provenance.source.replace('https://github.com/', '')}
                    </a>{' '}
                    @ {e.provenance.ref}
                  </td>
                  <td style={{ textAlign: 'left' }}>{e.provenance.commit.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </>
  );
}
