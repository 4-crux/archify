// Orthogonal relationship routing for box-and-line model diagrams (domain,
// erd, http-call). This is the architecture renderer's automatic routing,
// factored so any box collection can reuse it: side selection, automatic port
// spread, side-aware bridges, and obstacle-clearing doglegs. Authored `via`,
// `route`, `fromSide`, and `toSide` remain authoritative exactly as in
// architecture mode.
import {
  segmentIntersectsRect,
  anchor,
  automaticPortSpread,
  automaticPortRhythmBridge,
  chosenSide,
  routeHonorsEndpointSides,
  normalizeRoutePoints,
  roundedPath,
} from '../shared/geometry.mjs';

const OUTWARD_SIDE_VECTOR = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
};

const AUTOMATIC_PORT_CORNER_GUTTER = 16;
const AUTOMATIC_PORT_ALIGNMENT_DELTA = 16;

function outwardStub(point, side, distance = 24) {
  const [dx, dy] = OUTWARD_SIDE_VECTOR[side] || [0, 0];
  return [point[0] + dx * distance, point[1] + dy * distance];
}

function collinearBacktrack(a, b, c) {
  const first = [b[0] - a[0], b[1] - a[1]];
  const second = [c[0] - b[0], c[1] - b[1]];
  const cross = first[0] * second[1] - first[1] * second[0];
  const dot = first[0] * second[0] + first[1] * second[1];
  return Math.abs(cross) <= 0.0001 && dot < -0.0001;
}

function sideAwareBridgeCandidates(start, end, fromSide, toSide) {
  const startStub = outwardStub(start, fromSide);
  const endStub = outwardStub(end, toSide);
  const rawCandidates = [];
  const minimumBridge = 16;
  const verticalSides = new Set(['top', 'bottom']);
  const horizontalSides = new Set(['left', 'right']);

  if (verticalSides.has(fromSide) && verticalSides.has(toSide)
      && Math.abs(start[0] - end[0]) < minimumBridge) {
    for (const channelX of [
      Math.max(start[0], end[0]) + minimumBridge,
      Math.min(start[0], end[0]) - minimumBridge,
    ]) {
      rawCandidates.push([startStub, [channelX, startStub[1]], [channelX, endStub[1]], endStub]);
    }
  }
  if (horizontalSides.has(fromSide) && horizontalSides.has(toSide)
      && Math.abs(start[1] - end[1]) < minimumBridge) {
    for (const channelY of [
      Math.max(start[1], end[1]) + minimumBridge,
      Math.min(start[1], end[1]) - minimumBridge,
    ]) {
      rawCandidates.push([startStub, [startStub[0], channelY], [endStub[0], channelY], endStub]);
    }
  }

  rawCandidates.push(
    [startStub, [endStub[0], startStub[1]], endStub],
    [startStub, [startStub[0], endStub[1]], endStub],
  );
  return rawCandidates.map((candidate) => normalizeRoutePoints([start, ...candidate, end]))
    .filter((points) => points.length >= 2)
    .filter((points) => !collinearBacktrack(points[0], points[1], points[2] || points[1]))
    .filter((points) => !collinearBacktrack(points.at(-3) || points.at(-2), points.at(-2), points.at(-1)))
    .filter((points) => routeHonorsEndpointSides(points, fromSide, toSide))
    .map((points) => points.slice(1, -1));
}

function portHasCornerClearance(rect, side, point) {
  if (side === 'left' || side === 'right') {
    const inset = Math.min(AUTOMATIC_PORT_CORNER_GUTTER, rect.height / 2);
    return point[1] >= rect.y + inset && point[1] <= rect.y + rect.height - inset;
  }
  if (side === 'top' || side === 'bottom') {
    const inset = Math.min(AUTOMATIC_PORT_CORNER_GUTTER, rect.width / 2);
    return point[0] >= rect.x + inset && point[0] <= rect.x + rect.width - inset;
  }
  return false;
}

// Model boxes vary in height and width, so side inference follows the
// dominant axis between centers instead of the architecture renderer's
// horizontal-first rule; stacked boxes connect top-to-bottom.
export function dominantFromSide(from, to) {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function dominantToSide(from, to) {
  const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  return opposite[dominantFromSide(from, to)];
}

export function createModelRouter({ relations, boxes, cornerRadius = 8 }) {
  const relationList = Array.isArray(relations) ? relations : [];
  const pathCache = new Map();
  const automaticPorts = automaticPortSpread(relationList, boxes, {
    sideFor: (relation, endpoint) => {
      const from = boxes.get(relation.from);
      const to = boxes.get(relation.to);
      return endpoint === 'source' ? dominantFromSide(from, to) : dominantToSide(from, to);
    },
  });

  function routeClearsBoxes(relation, points, clearance = 2) {
    const endpointIds = new Set([relation.from, relation.to]);
    for (const box of boxes.values()) {
      if (endpointIds.has(box.id)) continue;
      for (let index = 0; index < points.length - 1; index += 1) {
        if (segmentIntersectsRect({ start: points[index], end: points[index + 1] }, box, clearance)) return false;
      }
    }
    return true;
  }

  function routeClearsEndpointBoxes(points, from, to) {
    const lastSegment = points.length - 2;
    for (let index = 0; index <= lastSegment; index += 1) {
      const segment = { start: points[index], end: points[index + 1] };
      if (index > 0 && segmentIntersectsRect(segment, from)) return false;
      if (index < lastSegment && segmentIntersectsRect(segment, to)) return false;
    }
    return true;
  }

  function alignFacingPorts(relation, from, to, start, end, fromSide, toSide, ports) {
    const hasExplicitGeometry = relation.via || (relation.route && relation.route !== 'auto') || relation.labelAt;
    const horizontallyFacing = (fromSide === 'right' && toSide === 'left') || (fromSide === 'left' && toSide === 'right');
    const verticallyFacing = (fromSide === 'bottom' && toSide === 'top') || (fromSide === 'top' && toSide === 'bottom');
    if (hasExplicitGeometry || (!horizontallyFacing && !verticallyFacing)) return { start, end };
    const fromSpread = Boolean(ports?.from);
    const toSpread = Boolean(ports?.to);
    if (fromSpread && toSpread) return { start, end };
    const hasExplicitSides = (relation.fromSide && relation.fromSide !== 'auto') || (relation.toSide && relation.toSide !== 'auto');
    if (!fromSpread && !toSpread && hasExplicitSides) return { start, end };
    const alignmentDelta = horizontallyFacing ? Math.abs(start[1] - end[1]) : Math.abs(start[0] - end[0]);
    if (alignmentDelta >= AUTOMATIC_PORT_ALIGNMENT_DELTA) return { start, end };
    const alignEndToStart = horizontallyFacing ? { start, end: [end[0], start[1]] } : { start, end: [start[0], end[1]] };
    const alignStartToEnd = horizontallyFacing ? { start: [start[0], end[1]], end } : { start: [end[0], start[1]], end };
    const candidates = fromSpread ? [alignEndToStart] : toSpread ? [alignStartToEnd] : [alignEndToStart, alignStartToEnd];
    for (const candidate of candidates) {
      const points = [candidate.start, candidate.end];
      if (portHasCornerClearance(from, fromSide, candidate.start)
          && portHasCornerClearance(to, toSide, candidate.end)
          && routeHonorsEndpointSides(points, fromSide, toSide)
          && routeClearsEndpointBoxes(points, from, to)
          && routeClearsBoxes(relation, points)) {
        return candidate;
      }
    }
    return { start, end };
  }

  function routeVia(relation, from, to, start, end, fromSide, toSide) {
    if (relation.via) return relation.via;
    switch (relation.route || 'auto') {
      case 'straight':
        return [];
      case 'orthogonal-h': {
        const midX = (start[0] + end[0]) / 2;
        return [[midX, start[1]], [midX, end[1]]];
      }
      case 'orthogonal-v': {
        const midY = (start[1] + end[1]) / 2;
        return [[start[0], midY], [end[0], midY]];
      }
      case 'auto':
      default: {
        const deltaX = Math.abs(start[0] - end[0]);
        const deltaY = Math.abs(start[1] - end[1]);
        if ((deltaX < 4 || deltaY < 4) && routeHonorsEndpointSides([start, end], fromSide, toSide)) return [];

        const rhythmBridge = automaticPortRhythmBridge(start, end, fromSide, toSide, {
          accept: (points) => routeClearsEndpointBoxes(points, from, to) && routeClearsBoxes(relation, points),
        });
        if (rhythmBridge) return rhythmBridge.slice(1, -1);

        const minimumStub = 8;
        const fromVerticalSide = start[1] === from.y || start[1] === from.y + from.height;
        const toVerticalSide = end[1] === to.y || end[1] === to.y + to.height;
        if (fromVerticalSide && toVerticalSide && deltaX < minimumStub * 2) {
          for (const channelX of [Math.max(start[0], end[0]) + minimumStub * 2, Math.min(start[0], end[0]) - minimumStub * 2]) {
            const candidate = [[channelX, start[1]], [channelX, end[1]]];
            const points = [start, ...candidate, end];
            if (routeHonorsEndpointSides(points, fromSide, toSide) && routeClearsBoxes(relation, points)) return candidate;
          }
        }
        const fromHorizontalSide = start[0] === from.x || start[0] === from.x + from.width;
        const toHorizontalSide = end[0] === to.x || end[0] === to.x + to.width;
        if (fromHorizontalSide && toHorizontalSide && deltaY < minimumStub * 2) {
          for (const channelY of [Math.max(start[1], end[1]) + minimumStub * 2, Math.min(start[1], end[1]) - minimumStub * 2]) {
            const candidate = [[start[0], channelY], [end[0], channelY]];
            const points = [start, ...candidate, end];
            if (routeHonorsEndpointSides(points, fromSide, toSide) && routeClearsBoxes(relation, points)) return candidate;
          }
        }

        const midX = (start[0] + end[0]) / 2;
        const horizontalFirst = [[midX, start[1]], [midX, end[1]]];
        const midY = (start[1] + end[1]) / 2;
        const verticalFirst = [[start[0], midY], [end[0], midY]];
        const candidates = [horizontalFirst, verticalFirst];
        const sideSafe = candidates.filter((candidate) => routeHonorsEndpointSides([start, ...candidate, end], fromSide, toSide));
        const sideAware = sideAwareBridgeCandidates(start, end, fromSide, toSide);
        const nearParallelPorts = (
          ((fromSide === 'top' || fromSide === 'bottom') && (toSide === 'top' || toSide === 'bottom') && deltaX < minimumStub * 2)
          || ((fromSide === 'left' || fromSide === 'right') && (toSide === 'left' || toSide === 'right') && deltaY < minimumStub * 2)
        );
        const ordered = [
          ...(nearParallelPorts ? sideAware : sideSafe),
          ...(nearParallelPorts ? sideSafe : sideAware),
          ...candidates.filter((candidate) => !sideSafe.includes(candidate)),
        ];
        for (const candidate of ordered) {
          const points = [start, ...candidate, end];
          if (routeClearsEndpointBoxes(points, from, to) && routeClearsBoxes(relation, points)) return candidate;
        }
        return sideSafe[0] || sideAware[0] || horizontalFirst;
      }
    }
  }

  function sides(relation) {
    const from = boxes.get(relation.from);
    const to = boxes.get(relation.to);
    return {
      fromSide: chosenSide(relation.fromSide, dominantFromSide(from, to)),
      toSide: chosenSide(relation.toSide, dominantToSide(from, to)),
    };
  }

  function endpointSide(relation, endpoint) {
    const field = endpoint === 'source' ? 'fromSide' : 'toSide';
    if (relation[field] && relation[field] !== 'auto') return relation[field];
    return sides(relation)[field];
  }

  function pathFor(relation) {
    if (pathCache.has(relation)) return pathCache.get(relation);
    const from = boxes.get(relation.from);
    const to = boxes.get(relation.to);
    const ports = automaticPorts.get(relation);
    const { fromSide, toSide } = sides(relation);
    const baseStart = ports?.from || anchor(from, fromSide);
    const baseEnd = ports?.to || anchor(to, toSide);
    const { start, end } = alignFacingPorts(relation, from, to, baseStart, baseEnd, fromSide, toSide, ports);
    const points = [start, ...routeVia(relation, from, to, start, end, fromSide, toSide), end];
    const routed = { d: roundedPath(points, cornerRadius), points };
    pathCache.set(relation, routed);
    return routed;
  }

  return { pathFor, endpointSide, sides };
}
