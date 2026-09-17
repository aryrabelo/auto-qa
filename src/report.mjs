import { writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function localLink(directory, path) {
  if (!path) return null;
  const rel = relative(directory, path);
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel.split('/').map(encodeURIComponent).join('/');
}

export async function writeReport(directory, result) {
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2));
  const videoPaths = result.recording?.chunks?.map(c => c.path) || [result.recording?.outPath];
  const videos = videoPaths.map(path => localLink(directory, path)).filter(Boolean);
  const screenshot = localLink(directory, result.screenshot?.path);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>QA run: ${escape(result.status)}</title><style>
body{font:16px/1.55 system-ui;margin:40px auto;max-width:960px;padding:0 24px;background:#f6f7f9;color:#142131}h1{font-size:32px}section{background:white;padding:24px;margin:20px 0;border-radius:12px}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd}video,img{max-width:100%;max-height:640px}small{color:#536270}
</style><h1>${escape(result.status.toUpperCase())}</h1><p>${escape(result.prompt)}</p>
<p>${escape(result.reason)} · ${result.mode === 'simulation' ? 'SIMULATED RUN' : 'LIVE RUN'}</p>
<section><h2>Run details</h2><p>${(result.durationMs / 1000).toFixed(2)} seconds · ${result.steps.length} action decisions${result.verdict ? ' + 1 QA review' : ''} · ${result.usage.inputTokens} input tokens</p>
<p>Estimated Jev inference cost: ${result.estimatedInferenceCostUsd == null ? 'unavailable' : '$' + result.estimatedInferenceCostUsd.toFixed(8)}</p>
<small>Uses the configured input-token rate; excludes devices and other services. ${result.usage.complete ? '' : 'Some request usage is unavailable.'} ${result.mode === 'simulation' ? 'Simulation timings are not a Jev benchmark.' : ''}</small></section>
<section><h2>QA verdict</h2>${result.verdict ? `<p>${escape(result.verdict.choice)} · confidence ${escape(result.verdict.confidence)} · ${escape(result.verdict.latencyMs)} ms</p><p><a href="snapshot-final.json">Final app state</a></p><small>Jev evaluated the task against the observed app states and actions. This is a model judgment, not a deterministic assertion. The run status also accounts for confidence and cancellation.</small>` : '<p>No final verdict. See the run status and decision trace.</p>'}</section>
<section><h2>Evidence</h2>${videos.length ? videos.map(v => `<video controls src="${escape(v)}"></video>`).join('') : '<p>No video recorded.</p>'}${screenshot ? `<p><a href="${escape(screenshot)}">Final screenshot</a></p><img alt="Final app state" src="${escape(screenshot)}">` : ''}</section>
<section><h2>Decisions</h2><table><tr><th>Step</th><th>Action</th><th>Confidence</th><th>Model time</th></tr>${result.steps.map(s => `<tr><td><a href="${escape(s.snapshot)}">${s.step}</a></td><td>${escape(s.action)}</td><td>${s.confidence.toFixed(3)}</td><td>${s.latencyMs.toFixed(1)} ms</td></tr>`).join('')}</table></section>
${result.warnings.length ? `<section><h2>Run notes</h2><ul>${result.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul></section>` : ''}
<p><a href="report.json">Full JSON report</a> · <a href="trace.jsonl">Decision trace</a></p></html>`;
  await writeFile(join(directory, 'report.html'), html);
}

