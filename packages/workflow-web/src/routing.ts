/** The page's location: which workflow, and optionally which of its runs, as `#/w/<id>?run=<runId>`. */
export interface Route {
  workflowId: string | null;
  runId: string | null;
}

export function readRoute(): Route {
  const match = /^#\/w\/([^?]+)(?:\?run=(.+))?$/.exec(window.location.hash);
  return {
    workflowId: match?.[1] ? decodeURIComponent(match[1]) : null,
    runId: match?.[2] ? decodeURIComponent(match[2]) : null,
  };
}

export function writeRoute(route: Route) {
  const hash = route.workflowId
    ? `#/w/${encodeURIComponent(route.workflowId)}${route.runId ? `?run=${encodeURIComponent(route.runId)}` : ''}`
    : '#/';
  if (window.location.hash !== hash) window.history.pushState(null, '', hash);
}
