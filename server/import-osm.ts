import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { createOSMStream } from "osm-pbf-parser-node";
import {
  replaceOSMData,
  type OSMImportRecord,
  type OSMPOIRecord,
  type OSMRoadEdgeRecord,
  type OSMRoadNodeRecord,
  type OSMRoadWayRecord
} from "./db.js";

type OSMHeader = {
  bbox?: { left: number; right: number; top: number; bottom: number };
};

type OSMNode = {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

type OSMWay = {
  type: "way";
  id: number;
  refs: number[];
  tags?: Record<string, string>;
};

type InterestingWay = {
  id: number;
  refs: number[];
  tags: Record<string, string>;
  role: "road" | "poi";
};

const roadHighways = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "service",
  "living_street",
  "pedestrian",
  "track",
  "path",
  "footway",
  "cycleway",
  "steps"
]);

function isRoadWay(tags: Record<string, string> | undefined) {
  const highway = tags?.highway;
  return Boolean(highway && roadHighways.has(highway));
}

function inferPoiCategory(tags: Record<string, string> | undefined) {
  if (!tags) {
    return null;
  }
  if (tags.tourism) return { category: "tourism", subtype: tags.tourism };
  if (tags.amenity) return { category: "amenity", subtype: tags.amenity };
  if (tags.leisure) return { category: "leisure", subtype: tags.leisure };
  if (tags.shop) return { category: "shop", subtype: tags.shop };
  if (tags.building) return { category: "building", subtype: tags.building };
  if (tags.office) return { category: "office", subtype: tags.office };
  if (tags.public_transport) return { category: "public_transport", subtype: tags.public_transport };
  if (tags.railway) return { category: "railway", subtype: tags.railway };
  if (tags.landuse) return { category: "landuse", subtype: tags.landuse };
  return null;
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

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error("usage: npm run import:osm -- /absolute/path/to/file.osm.pbf");
  }

  const sourcePath = path.resolve(input);
  const requiredNodeIds = new Set<number>();
  const interestingWays: InterestingWay[] = [];
  const nodePois: OSMPOIRecord[] = [];
  let header: OSMHeader | null = null;
  let scannedNodes = 0;
  let scannedWays = 0;

  console.log(`Scanning ${sourcePath}`);

  for await (const item of createOSMStream(sourcePath, { withTags: true, withInfo: false })) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    if (!("type" in item)) {
      header = item as OSMHeader;
      continue;
    }

    if ((item as OSMNode).type === "node") {
      scannedNodes += 1;
      const node = item as OSMNode;
      const poiCategory = inferPoiCategory(node.tags);
      if (poiCategory) {
        nodePois.push({
          osmKey: `node:${node.id}`,
          osmType: "node",
          osmId: node.id,
          name: node.tags?.name ?? null,
          category: poiCategory.category,
          subtype: poiCategory.subtype,
          lat: node.lat,
          lon: node.lon,
          tagsJson: JSON.stringify(node.tags ?? {})
        });
      }
      continue;
    }

    if ((item as OSMWay).type === "way") {
      scannedWays += 1;
      const way = item as OSMWay;
      const tags = way.tags ?? {};
      if (isRoadWay(tags)) {
        interestingWays.push({ id: way.id, refs: way.refs, tags, role: "road" });
        way.refs.forEach((ref) => requiredNodeIds.add(ref));
        continue;
      }
      if (inferPoiCategory(tags)) {
        interestingWays.push({ id: way.id, refs: way.refs, tags, role: "poi" });
        way.refs.forEach((ref) => requiredNodeIds.add(ref));
      }
    }
  }

  console.log(
    `First pass complete: ${scannedNodes} nodes, ${scannedWays} ways, ${interestingWays.length} selected ways, ${nodePois.length} node POIs`
  );

  const nodeCoords = new Map<number, { lat: number; lon: number }>();
  for await (const item of createOSMStream(sourcePath, { withTags: false, withInfo: false })) {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      continue;
    }
    if ((item as OSMNode).type !== "node") {
      continue;
    }
    const node = item as OSMNode;
    if (requiredNodeIds.has(node.id)) {
      nodeCoords.set(node.id, { lat: node.lat, lon: node.lon });
    }
  }

  console.log(`Second pass complete: ${nodeCoords.size} referenced node coordinates loaded`);

  const roadNodeMap = new Map<number, OSMRoadNodeRecord>();
  const roadWays: OSMRoadWayRecord[] = [];
  const roadEdges: OSMRoadEdgeRecord[] = [];
  const poiWays: OSMPOIRecord[] = [];

  for (const way of interestingWays) {
    const coords = way.refs
      .map((ref) => {
        const coord = nodeCoords.get(ref);
        return coord ? { id: ref, ...coord } : null;
      })
      .filter((entry): entry is { id: number; lat: number; lon: number } => entry !== null);

    if (coords.length < 2) {
      continue;
    }

    if (way.role === "road") {
      coords.forEach((coord) => {
        roadNodeMap.set(coord.id, { id: coord.id, lat: coord.lat, lon: coord.lon });
      });

      roadWays.push({
        id: way.id,
        name: way.tags.name ?? null,
        highway: way.tags.highway ?? "road",
        oneway: way.tags.oneway === "yes" ? 1 : 0,
        maxspeed: way.tags.maxspeed ?? null,
        surface: way.tags.surface ?? null,
        refsJson: JSON.stringify(coords.map((coord) => coord.id)),
        geometryJson: JSON.stringify(coords.map((coord) => [coord.lon, coord.lat]))
      });

      for (let index = 0; index < coords.length - 1; index += 1) {
        const from = coords[index];
        const to = coords[index + 1];
        const distance = haversineMeters(from, to);
        roadEdges.push({
          wayId: way.id,
          seq: index,
          fromNodeId: from.id,
          toNodeId: to.id,
          distance
        });
        if (way.tags.oneway !== "yes") {
          roadEdges.push({
            wayId: way.id,
            seq: index,
            fromNodeId: to.id,
            toNodeId: from.id,
            distance
          });
        }
      }
      continue;
    }

    const poiCategory = inferPoiCategory(way.tags);
    if (!poiCategory) {
      continue;
    }

    const lat = coords.reduce((sum, coord) => sum + coord.lat, 0) / coords.length;
    const lon = coords.reduce((sum, coord) => sum + coord.lon, 0) / coords.length;
    poiWays.push({
      osmKey: `way:${way.id}`,
      osmType: "way",
      osmId: way.id,
      name: way.tags.name ?? null,
      category: poiCategory.category,
      subtype: poiCategory.subtype,
      lat,
      lon,
      tagsJson: JSON.stringify(way.tags)
    });
  }

  const bbox = header?.bbox
    ? {
        minLon: header.bbox.left / 1e9,
        maxLon: header.bbox.right / 1e9,
        minLat: header.bbox.bottom / 1e9,
        maxLat: header.bbox.top / 1e9
      }
    : (() => {
        let minLon = Number.POSITIVE_INFINITY;
        let maxLon = Number.NEGATIVE_INFINITY;
        let minLat = Number.POSITIVE_INFINITY;
        let maxLat = Number.NEGATIVE_INFINITY;
        for (const coord of nodeCoords.values()) {
          minLon = Math.min(minLon, coord.lon);
          maxLon = Math.max(maxLon, coord.lon);
          minLat = Math.min(minLat, coord.lat);
          maxLat = Math.max(maxLat, coord.lat);
        }
        return {
          minLon,
          maxLon,
          minLat,
          maxLat
        };
      })();

  const importRecord: OSMImportRecord = {
    id: uuidv4(),
    name: path.basename(sourcePath),
    sourcePath,
    importedAt: new Date().toISOString(),
    bbox,
    stats: {
      scannedNodes,
      scannedWays,
      roadNodes: roadNodeMap.size,
      roadWays: roadWays.length,
      roadEdges: roadEdges.length,
      pois: nodePois.length + poiWays.length
    }
  };

  replaceOSMData({
    importRecord,
    nodes: Array.from(roadNodeMap.values()),
    ways: roadWays,
    edges: roadEdges,
    pois: [...nodePois, ...poiWays]
  });

  console.log("OSM import complete");
  console.log(JSON.stringify(importRecord, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
