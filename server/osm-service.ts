import {
  getAllOSMPois,
  getAllOSMRoadEdges,
  getAllOSMRoadNodes,
  getAllOSMRoadWays,
  getLatestOSMImport
} from "./db.js";

type Strategy = "shortest-distance" | "shortest-time" | "avoid-crowded";
type Mode = "walk" | "bike" | "shuttle";

type NodeCoord = { id: number; lat: number; lon: number };
type Edge = {
  wayId: number;
  to: number;
  distance: number;
  highway: string;
  name: string | null;
};

type CachedWay = {
  id: number;
  name: string | null;
  highway: string;
  geometry: [number, number][];
  bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number };
};

type CachedPoi = {
  osmKey: string;
  osmType: "node" | "way";
  osmId: number;
  name: string | null;
  category: string;
  subtype: string | null;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  nearestNodeId: number | null;
};

type Cache = {
  importId: string;
  importName: string;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  stats: Record<string, number>;
  nodes: Map<number, NodeCoord>;
  adjacency: Map<number, Edge[]>;
  ways: CachedWay[];
  pois: CachedPoi[];
  poiByKey: Map<string, CachedPoi>;
  grid: Map<string, number[]>;
};

let cache: Cache | null = null;

function cellKey(lat: number, lon: number) {
  return `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const earthRadius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const alpha =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(alpha), Math.sqrt(1 - alpha));
}

function isModeAllowed(highway: string, mode: Mode) {
  if (mode === "walk") {
    return !["motorway"].includes(highway);
  }
  if (mode === "bike") {
    return !["motorway", "steps"].includes(highway);
  }
  return !["path", "footway", "cycleway", "steps"].includes(highway);
}

function speedMetersPerMinute(highway: string, mode: Mode) {
  if (mode === "walk") {
    return 5000 / 60;
  }
  if (mode === "bike") {
    if (["cycleway", "path"].includes(highway)) return 18000 / 60;
    if (["primary", "trunk"].includes(highway)) return 14000 / 60;
    return 16000 / 60;
  }
  if (["motorway", "trunk", "primary"].includes(highway)) return 36000 / 60;
  if (["secondary", "tertiary"].includes(highway)) return 28000 / 60;
  return 22000 / 60;
}

function edgeWeight(edge: Edge, strategy: Strategy, mode: Mode) {
  if (!isModeAllowed(edge.highway, mode)) {
    return Number.POSITIVE_INFINITY;
  }
  if (strategy === "shortest-distance") {
    return edge.distance;
  }
  const minutes = edge.distance / speedMetersPerMinute(edge.highway, mode);
  if (strategy === "shortest-time") {
    return minutes;
  }
  const penalty =
    mode === "walk" || mode === "bike"
      ? ["motorway", "trunk", "primary"].includes(edge.highway)
        ? 12
        : ["secondary", "tertiary"].includes(edge.highway)
          ? 5
          : 0
      : ["residential", "service", "living_street"].includes(edge.highway)
        ? 4
        : 0;
  return minutes + penalty;
}

function buildGrid(nodes: Map<number, NodeCoord>) {
  const grid = new Map<string, number[]>();
  nodes.forEach((node) => {
    const key = cellKey(node.lat, node.lon);
    const bucket = grid.get(key) ?? [];
    bucket.push(node.id);
    grid.set(key, bucket);
  });
  return grid;
}

function nearestNodeId(grid: Map<string, number[]>, nodes: Map<number, NodeCoord>, lat: number, lon: number) {
  const centerLat = Math.floor(lat * 100);
  const centerLon = Math.floor(lon * 100);
  let bestId: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let radius = 0; radius <= 3; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const bucket = grid.get(`${centerLat + dx}:${centerLon + dy}`);
        if (!bucket) {
          continue;
        }
        for (const nodeId of bucket) {
          const node = nodes.get(nodeId);
          if (!node) {
            continue;
          }
          const distance = haversineMeters({ lat, lon }, node);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestId = nodeId;
          }
        }
      }
    }
    if (bestId !== null) {
      break;
    }
  }

  return bestId;
}

function bboxIntersects(
  a: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  b: { minLon: number; maxLon: number; minLat: number; maxLat: number }
) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

function routeBBox(points: Array<{ lat: number; lon: number }>) {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  points.forEach((point) => {
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  });
  const lonPad = Math.max((maxLon - minLon) * 0.2, 0.01);
  const latPad = Math.max((maxLat - minLat) * 0.2, 0.008);
  return {
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
    minLat: minLat - latPad,
    maxLat: maxLat + latPad
  };
}

function buildCache(): Cache | null {
  const latest = getLatestOSMImport();
  if (!latest) {
    return null;
  }

  const nodes = new Map<number, NodeCoord>();
  getAllOSMRoadNodes().forEach((node) => {
    nodes.set(node.id, node);
  });

  const adjacency = new Map<number, Edge[]>();
  getAllOSMRoadEdges().forEach((edge) => {
    const bucket = adjacency.get(edge.from_node_id) ?? [];
    bucket.push({
      wayId: edge.way_id,
      to: edge.to_node_id,
      distance: edge.distance,
      highway: edge.highway,
      name: edge.name
    });
    adjacency.set(edge.from_node_id, bucket);
  });

  const ways = getAllOSMRoadWays().map((way) => {
    const geometry = JSON.parse(way.geometry_json) as [number, number][];
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    geometry.forEach(([lon, lat]) => {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    });
    return {
      id: way.id,
      name: way.name,
      highway: way.highway,
      geometry,
      bbox: { minLon, maxLon, minLat, maxLat }
    };
  });

  const grid = buildGrid(nodes);
  const pois = getAllOSMPois().map((poi) => ({
    osmKey: poi.osm_key,
    osmType: poi.osm_type,
    osmId: poi.osm_id,
    name: poi.name,
    category: poi.category,
    subtype: poi.subtype,
    lat: poi.lat,
    lon: poi.lon,
    tags: JSON.parse(poi.tags_json) as Record<string, string>,
    nearestNodeId: nearestNodeId(grid, nodes, poi.lat, poi.lon)
  }));

  return {
    importId: latest.id,
    importName: latest.name,
    bbox: latest.bbox,
    stats: latest.stats,
    nodes,
    adjacency,
    ways,
    pois,
    poiByKey: new Map(pois.map((poi) => [poi.osmKey, poi])),
    grid
  };
}

function ensureCache() {
  const latest = getLatestOSMImport();
  if (!latest) {
    cache = null;
    return null;
  }
  if (!cache || cache.importId !== latest.id) {
    cache = buildCache();
  }
  return cache;
}

class MinHeap {
  private items: Array<{ id: number; distance: number }> = [];

  push(item: { id: number; distance: number }) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) {
      return null;
    }
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  get size() {
    return this.items.length;
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= this.items[index].distance) {
        break;
      }
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    const length = this.items.length;
    while (true) {
      const left = index * 2 + 1;
      const right = index * 2 + 2;
      let smallest = index;
      if (left < length && this.items[left].distance < this.items[smallest].distance) {
        smallest = left;
      }
      if (right < length && this.items[right].distance < this.items[smallest].distance) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

function dijkstra(cacheValue: Cache, startId: number, endId: number, strategy: Strategy, mode: Mode) {
  const distances = new Map<number, number>();
  const previous = new Map<number, number | null>();
  const visited = new Set<number>();
  const heap = new MinHeap();
  distances.set(startId, 0);
  previous.set(startId, null);
  heap.push({ id: startId, distance: 0 });

  while (heap.size > 0) {
    const item = heap.pop();
    if (!item) {
      break;
    }
    const current = item.id;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current === endId) {
      break;
    }

    for (const edge of cacheValue.adjacency.get(current) ?? []) {
      if (visited.has(edge.to)) {
        continue;
      }
      const weight = edgeWeight(edge, strategy, mode);
      if (!Number.isFinite(weight)) {
        continue;
      }
      const candidate = (distances.get(current) ?? Number.POSITIVE_INFINITY) + weight;
      if (candidate < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, current);
        heap.push({ id: edge.to, distance: candidate });
      }
    }
  }

  const path: number[] = [];
  let current: number | null = endId;
  while (current !== null) {
    path.unshift(current);
    current = previous.get(current) ?? null;
  }
  if (path[0] !== startId) {
    return null;
  }

  let totalDistance = 0;
  let totalTime = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const edge = (cacheValue.adjacency.get(from) ?? []).find((item) => item.to === to);
    if (!edge) {
      continue;
    }
    totalDistance += edge.distance;
    totalTime += edge.distance / speedMetersPerMinute(edge.highway, mode);
  }

  return { path, totalDistance, totalTime };
}

export function getOSMSelectionPois(limit = 160, query?: string) {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    return [];
  }
  const normalized = query?.trim().toLowerCase();
  return cacheValue.pois
    .filter((poi) => poi.nearestNodeId !== null)
    .filter((poi) => Boolean(poi.name))
    .filter((poi) =>
      normalized ? `${poi.name ?? ""} ${poi.category} ${poi.subtype ?? ""}`.toLowerCase().includes(normalized) : true
    )
    .filter((poi) => ["tourism", "amenity", "leisure", "public_transport", "railway", "shop"].includes(poi.category))
    .slice(0, limit)
    .map((poi) => ({
      osmKey: poi.osmKey,
      name: poi.name,
      category: poi.category,
      subtype: poi.subtype,
      lat: poi.lat,
      lon: poi.lon
    }));
}

export function getOSMNearbyPois(params: {
  lat: number;
  lon: number;
  limit?: number;
  query?: string;
  category?: string;
}) {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    return [];
  }
  const normalized = params.query?.trim().toLowerCase();
  return cacheValue.pois
    .filter((poi) => Boolean(poi.name))
    .filter((poi) => (params.category ? poi.category === params.category : true))
    .filter((poi) =>
      normalized ? `${poi.name ?? ""} ${poi.category} ${poi.subtype ?? ""}`.toLowerCase().includes(normalized) : true
    )
    .map((poi) => ({
      osmKey: poi.osmKey,
      name: poi.name,
      category: poi.category,
      subtype: poi.subtype,
      lat: poi.lat,
      lon: poi.lon,
      distance: Math.round(haversineMeters({ lat: params.lat, lon: params.lon }, poi))
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, params.limit ?? 20);
}

export function getOSMViewportPois(params: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  limit?: number;
  query?: string;
}) {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    return [];
  }
  const normalized = params.query?.trim().toLowerCase();
  return cacheValue.pois
    .filter((poi) => Boolean(poi.name))
    .filter((poi) => poi.lat >= params.minLat && poi.lat <= params.maxLat && poi.lon >= params.minLon && poi.lon <= params.maxLon)
    .filter((poi) =>
      normalized ? `${poi.name ?? ""} ${poi.category} ${poi.subtype ?? ""}`.toLowerCase().includes(normalized) : true
    )
    .slice(0, params.limit ?? 80)
    .map((poi) => ({
      osmKey: poi.osmKey,
      name: poi.name,
      category: poi.category,
      subtype: poi.subtype,
      lat: poi.lat,
      lon: poi.lon
    }));
}

export function getOSMPoiByKey(osmKey: string) {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    return null;
  }
  const poi = cacheValue.poiByKey.get(osmKey);
  if (!poi) {
    return null;
  }
  return {
    osmKey: poi.osmKey,
    name: poi.name,
    category: poi.category,
    subtype: poi.subtype,
    lat: poi.lat,
    lon: poi.lon
  };
}

export function getOSMImportSummary() {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    return null;
  }
  return {
    id: cacheValue.importId,
    name: cacheValue.importName,
    bbox: cacheValue.bbox,
    stats: cacheValue.stats
  };
}

export function planOSMRoute(params: {
  startPoiKey: string;
  endPoiKey: string;
  waypointPoiKeys: string[];
  strategy: Strategy;
  mode: Mode;
}) {
  const cacheValue = ensureCache();
  if (!cacheValue) {
    throw new Error("当前没有已导入的 OSM 数据");
  }

  const checkpoints = [params.startPoiKey, ...params.waypointPoiKeys, params.endPoiKey]
    .map((key) => cacheValue.poiByKey.get(key) ?? null)
    .filter((poi): poi is CachedPoi => poi !== null);

  if (checkpoints.length < 2) {
    throw new Error("至少需要起点和终点");
  }

  for (const poi of checkpoints) {
    if (poi.nearestNodeId === null) {
      throw new Error(`点位 ${poi.name ?? poi.osmKey} 未能匹配到可通行路网`);
    }
  }

  const segments = [];
  const fullNodePath: number[] = [];
  let totalDistance = 0;
  let totalTime = 0;

  for (let index = 0; index < checkpoints.length - 1; index += 1) {
    const fromPoi = checkpoints[index];
    const toPoi = checkpoints[index + 1];
    const result = dijkstra(
      cacheValue,
      fromPoi.nearestNodeId as number,
      toPoi.nearestNodeId as number,
      params.strategy,
      params.mode
    );
    if (!result) {
      throw new Error(`未找到从 ${fromPoi.name ?? fromPoi.osmKey} 到 ${toPoi.name ?? toPoi.osmKey} 的路径`);
    }
    totalDistance += result.totalDistance;
    totalTime += result.totalTime;
    const coordinates = result.path
      .map((nodeId) => cacheValue.nodes.get(nodeId))
      .filter((node): node is NodeCoord => Boolean(node))
      .map((node) => [node.lon, node.lat] as [number, number]);

    if (index === 0) {
      fullNodePath.push(...result.path);
    } else {
      fullNodePath.push(...result.path.slice(1));
    }

    segments.push({
      fromPoiKey: fromPoi.osmKey,
      toPoiKey: toPoi.osmKey,
      fromLabel: fromPoi.name ?? fromPoi.osmKey,
      toLabel: toPoi.name ?? toPoi.osmKey,
      nodePath: result.path.map(String),
      coordinates,
      distance: Math.round(result.totalDistance),
      time: Number(result.totalTime.toFixed(1))
    });
  }

  const routePoints = fullNodePath
    .map((nodeId) => cacheValue.nodes.get(nodeId))
    .filter((node): node is NodeCoord => Boolean(node));
  const bbox = routeBBox(routePoints);
  const roads = cacheValue.ways
    .filter((way) => bboxIntersects(way.bbox, bbox))
    .slice(0, 1800)
    .map((way) => ({
      id: way.id,
      name: way.name,
      highway: way.highway,
      geometry: way.geometry
    }));
  const pois = cacheValue.pois
    .filter((poi) => poi.lon >= bbox.minLon && poi.lon <= bbox.maxLon && poi.lat >= bbox.minLat && poi.lat <= bbox.maxLat)
    .filter((poi) => poi.name)
    .slice(0, 80)
    .map((poi) => ({
      osmKey: poi.osmKey,
      name: poi.name,
      category: poi.category,
      subtype: poi.subtype,
      lat: poi.lat,
      lon: poi.lon
    }));

  return {
    mapName: cacheValue.importName.replace(".osm.pbf", ""),
    bbox,
    totalDistance: Math.round(totalDistance),
    totalTime: Number(totalTime.toFixed(1)),
    polyline: routePoints.map((node) => [node.lon, node.lat] as [number, number]),
    segments,
    roads,
    pois,
    selectedPois: checkpoints.map((poi) => ({
      osmKey: poi.osmKey,
      name: poi.name,
      category: poi.category,
      subtype: poi.subtype,
      lat: poi.lat,
      lon: poi.lon
    }))
  };
}
