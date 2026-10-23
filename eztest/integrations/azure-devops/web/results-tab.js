/**
 * The "EZTest" tab of a pipeline run. The EZTest task attaches the run's tab
 * data to the build (`##vso[task.addattachment type=eztest.report]`); this
 * page lists those attachments through the Build REST API with the
 * extension's access token and renders the newest one (one per job/shard).
 * `lib/SDK.min.js` is azure-devops-extension-sdk, copied in when packaging.
 */
import * as SDK from './lib/SDK.min.js';
import { renderMessage, renderReport } from './report-view.js';

const root = document.getElementById('eztest-root');
const BUILD_AREA = '5d6898bb-45ec-463f-95f9-54d49c71752e';

async function baseUrl() {
  try {
    const loc = await SDK.getService('ms.vss-features.location-service');
    return (await loc.getResourceAreaLocation(BUILD_AREA)).replace(/\/?$/, '/');
  } catch {
    const c = SDK.getPageContext && SDK.getPageContext().webContext && SDK.getPageContext().webContext.collection;
    if (c && c.uri) return c.uri.replace(/\/?$/, '/');
    throw new Error('Cannot find the Azure DevOps collection URL');
  }
}

async function api(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${new URL(url).pathname}`);
  return r.json();
}

async function show(buildId) {
  root.setAttribute('aria-busy', 'true');
  try {
    const token = await SDK.getAccessToken();
    const project = SDK.getWebContext().project.name;
    const base = await baseUrl();
    const list = await api(`${base}${encodeURIComponent(project)}/_apis/build/builds/${buildId}/attachments/eztest.report?api-version=7.1`, token);
    const items = (list.value || []).filter((a) => a && a._links && a._links.self && a._links.self.href);
    if (!items.length) return renderMessage(root, 'EZTest', 'No EZTest report was attached to this run yet. It appears when an EZTest step finishes.');
    // Several jobs (shards, environments) attach one each: show them all, newest first.
    const datas = [];
    for (const a of items.reverse()) datas.push(await api(a._links.self.href, token));
    if (datas.length === 1) return renderReport(root, datas[0]);
    const sections = datas.map(() => document.createElement('section'));
    root.replaceChildren(...sections);
    datas.forEach((d, i) => renderReport(sections[i], d));
    root.setAttribute('aria-busy', 'false');
  } catch (e) {
    renderMessage(root, 'EZTest', `The EZTest report could not be loaded: ${e.message}`);
  } finally {
    SDK.resize();
  }
}

async function start() {
  await SDK.init({ loaded: false, applyTheme: true });
  await SDK.ready();
  const config = SDK.getConfiguration() || {};
  let shown = false;
  if (typeof config.onBuildChanged === 'function') {
    config.onBuildChanged((build) => {
      shown = true;
      void show(build.id);
    });
  }
  if (!shown) {
    const nav = await SDK.getService('ms.vss-features.host-navigation-service').catch(() => undefined);
    const q = nav ? await nav.getQueryParams() : {};
    if (q && q.buildId) await show(Number(q.buildId));
  }
  await SDK.notifyLoadSucceeded();
}

start().catch((e) => {
  renderMessage(root, 'EZTest', `The EZTest tab could not start: ${e.message}`);
  if (SDK.notifyLoadFailed) void SDK.notifyLoadFailed(e);
});
