import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { users as seedUsers } from "../src/data/mockData.js";
import type { User } from "../src/types.js";
import { createSeedState, sanitizeState, type PublicAppState } from "./state.js";

const dataDir = path.resolve(".data");
const dbPath = path.join(dataDir, "journeycraft.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS osm_imports (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    bbox_json TEXT NOT NULL,
    stats_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS osm_road_nodes (
    id INTEGER PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS osm_road_ways (
    id INTEGER PRIMARY KEY,
    name TEXT,
    highway TEXT NOT NULL,
    oneway INTEGER NOT NULL DEFAULT 0,
    maxspeed TEXT,
    surface TEXT,
    refs_json TEXT NOT NULL,
    geometry_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS osm_road_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    way_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    from_node_id INTEGER NOT NULL,
    to_node_id INTEGER NOT NULL,
    distance REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS osm_pois (
    osm_key TEXT PRIMARY KEY,
    osm_type TEXT NOT NULL,
    osm_id INTEGER NOT NULL,
    name TEXT,
    category TEXT NOT NULL,
    subtype TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    tags_json TEXT NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_osm_road_edges_from ON osm_road_edges(from_node_id);
  CREATE INDEX IF NOT EXISTS idx_osm_road_edges_to ON osm_road_edges(to_node_id);
  CREATE INDEX IF NOT EXISTS idx_osm_pois_category ON osm_pois(category);
  CREATE INDEX IF NOT EXISTS idx_osm_pois_name ON osm_pois(name);
`);

function setStoreValue(key: string, value: unknown) {
  db.prepare(
    `
      INSERT INTO app_store (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function getStoreValue<T>(key: string): T | null {
  const row = db.prepare("SELECT value FROM app_store WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

function seedAuthUsers() {
  const countRow = db.prepare("SELECT COUNT(*) as count FROM auth_users").get() as { count: number };
  if (countRow.count > 0) {
    return;
  }

  const statement = db.prepare("INSERT INTO auth_users (id, email, password_hash) VALUES (?, ?, ?)");
  const insertMany = db.transaction((items: User[]) => {
    items.forEach((user) => {
      statement.run(user.id, user.email, bcrypt.hashSync(user.password ?? "123456", 10));
    });
  });
  insertMany(seedUsers);
}

function seedAppState() {
  const current = getStoreValue<PublicAppState>("state");
  if (current) {
    return;
  }
  setStoreValue("state", createSeedState());
}

seedAuthUsers();
seedAppState();

export function getAppState(): PublicAppState {
  const state = getStoreValue<PublicAppState>("state");
  if (!state) {
    const seeded = createSeedState();
    setStoreValue("state", seeded);
    return seeded;
  }
  return state;
}

export function saveAppState(state: PublicAppState) {
  setStoreValue("state", sanitizeState(state));
}

export function findAuthUserByEmail(email: string) {
  return db.prepare("SELECT id, email, password_hash FROM auth_users WHERE email = ?").get(email) as
    | { id: string; email: string; password_hash: string }
    | undefined;
}

export function createAuthUser(id: string, email: string, password: string) {
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO auth_users (id, email, password_hash) VALUES (?, ?, ?)").run(id, email, passwordHash);
}

export function updateAuthPassword(userId: string, password: string) {
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

export function verifyPassword(email: string, password: string) {
  const authUser = findAuthUserByEmail(email);
  if (!authUser) {
    return null;
  }
  const ok = bcrypt.compareSync(password, authUser.password_hash);
  return ok ? authUser : null;
}

export type OSMImportRecord = {
  id: string;
  name: string;
  sourcePath: string;
  importedAt: string;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  stats: Record<string, number>;
};

export type OSMRoadNodeRecord = {
  id: number;
  lat: number;
  lon: number;
};

export type OSMRoadWayRecord = {
  id: number;
  name: string | null;
  highway: string;
  oneway: number;
  maxspeed: string | null;
  surface: string | null;
  refsJson: string;
  geometryJson: string;
};

export type OSMRoadEdgeRecord = {
  wayId: number;
  seq: number;
  fromNodeId: number;
  toNodeId: number;
  distance: number;
};

export type OSMPOIRecord = {
  osmKey: string;
  osmType: "node" | "way";
  osmId: number;
  name: string | null;
  category: string;
  subtype: string | null;
  lat: number;
  lon: number;
  tagsJson: string;
};

export function replaceOSMData(payload: {
  importRecord: OSMImportRecord;
  nodes: OSMRoadNodeRecord[];
  ways: OSMRoadWayRecord[];
  edges: OSMRoadEdgeRecord[];
  pois: OSMPOIRecord[];
}) {
  const insertImport = db.prepare(
    "INSERT INTO osm_imports (id, name, source_path, imported_at, bbox_json, stats_json) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertNode = db.prepare("INSERT INTO osm_road_nodes (id, lat, lon) VALUES (?, ?, ?)");
  const insertWay = db.prepare(
    "INSERT INTO osm_road_ways (id, name, highway, oneway, maxspeed, surface, refs_json, geometry_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertEdge = db.prepare(
    "INSERT INTO osm_road_edges (way_id, seq, from_node_id, to_node_id, distance) VALUES (?, ?, ?, ?, ?)"
  );
  const insertPoi = db.prepare(
    "INSERT INTO osm_pois (osm_key, osm_type, osm_id, name, category, subtype, lat, lon, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM osm_imports").run();
    db.prepare("DELETE FROM osm_road_edges").run();
    db.prepare("DELETE FROM osm_road_ways").run();
    db.prepare("DELETE FROM osm_road_nodes").run();
    db.prepare("DELETE FROM osm_pois").run();

    insertImport.run(
      payload.importRecord.id,
      payload.importRecord.name,
      payload.importRecord.sourcePath,
      payload.importRecord.importedAt,
      JSON.stringify(payload.importRecord.bbox),
      JSON.stringify(payload.importRecord.stats)
    );

    payload.nodes.forEach((node) => {
      insertNode.run(node.id, node.lat, node.lon);
    });
    payload.ways.forEach((way) => {
      insertWay.run(way.id, way.name, way.highway, way.oneway, way.maxspeed, way.surface, way.refsJson, way.geometryJson);
    });
    payload.edges.forEach((edge) => {
      insertEdge.run(edge.wayId, edge.seq, edge.fromNodeId, edge.toNodeId, edge.distance);
    });
    payload.pois.forEach((poi) => {
      insertPoi.run(
        poi.osmKey,
        poi.osmType,
        poi.osmId,
        poi.name,
        poi.category,
        poi.subtype,
        poi.lat,
        poi.lon,
        poi.tagsJson
      );
    });
  });

  transaction();
}

export function getLatestOSMImport() {
  const row = db
    .prepare("SELECT id, name, source_path, imported_at, bbox_json, stats_json FROM osm_imports ORDER BY imported_at DESC LIMIT 1")
    .get() as
    | {
        id: string;
        name: string;
        source_path: string;
        imported_at: string;
        bbox_json: string;
        stats_json: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    importedAt: row.imported_at,
    bbox: JSON.parse(row.bbox_json) as OSMImportRecord["bbox"],
    stats: JSON.parse(row.stats_json) as Record<string, number>
  };
}

export function getOSMPoiSamples(limit = 20, category?: string) {
  const rows = category
    ? db
        .prepare(
          "SELECT osm_key, osm_type, osm_id, name, category, subtype, lat, lon FROM osm_pois WHERE category = ? ORDER BY name IS NULL, name LIMIT ?"
        )
        .all(category, limit)
    : db
        .prepare(
          "SELECT osm_key, osm_type, osm_id, name, category, subtype, lat, lon FROM osm_pois ORDER BY name IS NULL, name LIMIT ?"
        )
        .all(limit);
  return rows;
}

export function getOSMRoadSamples(limit = 20) {
  return db
    .prepare(
      "SELECT id, name, highway, oneway, maxspeed, surface FROM osm_road_ways ORDER BY name IS NULL, name LIMIT ?"
    )
    .all(limit);
}

export function getAllOSMRoadNodes() {
  return db.prepare("SELECT id, lat, lon FROM osm_road_nodes").all() as Array<{
    id: number;
    lat: number;
    lon: number;
  }>;
}

export function getAllOSMRoadWays() {
  return db
    .prepare(
      "SELECT id, name, highway, oneway, maxspeed, surface, refs_json, geometry_json FROM osm_road_ways"
    )
    .all() as Array<{
    id: number;
    name: string | null;
    highway: string;
    oneway: number;
    maxspeed: string | null;
    surface: string | null;
    refs_json: string;
    geometry_json: string;
  }>;
}

export function getAllOSMRoadEdges() {
  return db
    .prepare(
      `
        SELECT
          e.way_id,
          e.seq,
          e.from_node_id,
          e.to_node_id,
          e.distance,
          w.highway,
          w.name
        FROM osm_road_edges e
        JOIN osm_road_ways w ON w.id = e.way_id
      `
    )
    .all() as Array<{
    way_id: number;
    seq: number;
    from_node_id: number;
    to_node_id: number;
    distance: number;
    highway: string;
    name: string | null;
  }>;
}

export function getAllOSMPois() {
  return db
    .prepare(
      "SELECT osm_key, osm_type, osm_id, name, category, subtype, lat, lon, tags_json FROM osm_pois"
    )
    .all() as Array<{
    osm_key: string;
    osm_type: "node" | "way";
    osm_id: number;
    name: string | null;
    category: string;
    subtype: string | null;
    lat: number;
    lon: number;
    tags_json: string;
  }>;
}
