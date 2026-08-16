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
            structured per-repetition <code>failures</code>, and per-repetition wire{' '}
            <code>detailSamples</code>. Entry manifests and their checked bundles are build source.
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
            framework. The Web boundary is <b>in-page pointerdown → the first animation frame
            where a composed-DOM predicate holds</b>. The Native boundary is <b>input handler →
            second native animation frame</b>, emitted by the bundle on the device clock and read
            through the Lynx Runtime console. Every featured entry uses real Native touch input.
            Octane waits for its renderer transport acknowledgement before two Native frames and
            emits a post-ACK state snapshot, which the adapter checks against the requested
            workload. Its DevTool driver is diagnostic-only and has a distinct recorded source.
            Native startup normally comes from Lynx pipeline performance entries (<b>open →
            FCP</b>) on bundles whose first screen pre-renders N rows. Octane's custom renderer
            publishes no such entry in this Explorer build, so it reports no Native FCP; its
            transport-ACK and post-ACK-frame startup metrics are isolated under different names
            and boundaries.
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
            The two harnesses are separate comparison domains. Web numbers are
            Lynx-for-Web-in-Chromium; Native numbers are real <code>main.lynx.bundle</code> runs in
            LynxExplorer on a leased Android Sandbox device. They are never charted against one
            another. A timeout or an unreachable prestate is retained as DNF with structured
            evidence rather than omitted or replaced with a proxy number.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">machines &amp; calibration</div>
        <div className="card-desc">
          Web featured charts are sourced from one coherent run: <code>{COMPARISON.runFile}</code> on machine{' '}
          <code>{COMPARISON.machineId}</code>, preflight score {COMPARISON.calibration.score} (v
          {COMPARISON.calibration.probeVersion}). Native featured charts combine one complete run
          per entry only when every run has the same device and environment identity. The collector
          keeps partial, stale-commit, and cross-machine records for provenance, but never merges
          them into the default ranking. Opt-in Lab
          variants marked <b>≈ calibrated</b> come from one complete historical run per entry;
          millisecond fields are multiplied by source-score / comparison-score. Heap, wire, bundle,
          and count fields cannot be CPU-calibrated and remain explicitly historical values.
        </div>
        <details className="data-table" open>
          <summary>Published harness cohorts</summary>
          <table>
            <thead>
              <tr><th>harness</th><th>environment</th><th>machine</th><th>entries</th><th>source runs</th></tr>
            </thead>
            <tbody>
              {COMPARISON.harnesses.map((cohort) => (
                <tr key={cohort.harness}>
                  <td>{cohort.harness}</td>
                  <td style={{ textAlign: 'left' }}>{cohort.environment ?? '—'}</td>
                  <td>{cohort.machineId}</td>
                  <td>{cohort.entryIds.length}</td>
                  <td>{cohort.sourceRunFiles.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
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
