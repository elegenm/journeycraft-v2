import fs from "node:fs";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { campuses } from "../src/data/mockData.js";
import type { AppState, Journal, PreferenceTag, User } from "../src/types.js";
import {
  createAuthUser,
  getLatestOSMImport,
  getOSMPoiSamples,
  getOSMRoadSamples,
  getAppState,
  saveAppState,
  updateAuthPassword,
  verifyPassword
} from "./db.js";
import {
  createPublicUser,
  ensureUserCollections,
  sanitizeState,
  type PublicAppState
} from "./state.js";
import { ensureStorage, uploadObject, uploadsStaticPath } from "./storage.js";
import {
  getOSMImportSummary,
  getOSMNearbyPois,
  getOSMPoiByKey,
  getOSMSelectionPois,
  getOSMViewportPois,
  planOSMRoute
} from "./osm-service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const port = Number(process.env.PORT ?? 3000);
const jwtSecret = process.env.JWT_SECRET ?? "journeycraft-demo-secret";
const distDir = path.resolve("dist");

app.use(express.json({ limit: "8mb" }));
app.use("/uploads", express.static(uploadsStaticPath()));

type JwtPayload = { userId: string; email: string };

function signToken(payload: JwtPayload) {
  return jwt.sign(payload, jwtSecret, { expiresIn: "7d" });
}

function readToken(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice("Bearer ".length);
}

function readViewer(req: express.Request) {
  const token = readToken(req);
  if (!token) {
    return null;
  }
  try {
    return jwt.verify(token, jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

function toStateForViewer(state: PublicAppState, viewerId: string | null): PublicAppState {
  return {
    ...state,
    currentUserId: viewerId
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/bootstrap", (req, res) => {
  const viewer = readViewer(req);
  const state = getAppState();
  res.json({ state: toStateForViewer(state, viewer?.userId ?? null) });
});

app.get("/api/osm/summary", (_req, res) => {
  res.json({
    import: getOSMImportSummary(),
    roads: getOSMRoadSamples(12),
    pois: getOSMPoiSamples(20)
  });
});

app.get("/api/osm/pois", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const namedOnly = req.query.named === "true";
  if (namedOnly || query) {
    return res.json({ items: getOSMSelectionPois(limit, query) });
  }
  return res.json({ items: getOSMPoiSamples(limit, category) });
});

app.get("/api/osm/nearby", (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ message: "lat 和 lon 必填" });
  }
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  return res.json({ items: getOSMNearbyPois({ lat, lon, limit, query, category }) });
});

app.get("/api/osm/viewport-pois", (req, res) => {
  const minLat = Number(req.query.minLat);
  const maxLat = Number(req.query.maxLat);
  const minLon = Number(req.query.minLon);
  const maxLon = Number(req.query.maxLon);
  if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) {
    return res.status(400).json({ message: "bbox 参数不完整" });
  }
  const limit = Math.min(Number(req.query.limit ?? 80), 200);
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  return res.json({ items: getOSMViewportPois({ minLat, maxLat, minLon, maxLon, limit, query }) });
});

app.get("/api/osm/poi", (req, res) => {
  const osmKey = typeof req.query.key === "string" ? req.query.key : "";
  if (!osmKey) {
    return res.status(400).json({ message: "缺少 key" });
  }
  const item = getOSMPoiByKey(osmKey);
  if (!item) {
    return res.status(404).json({ message: "未找到 POI" });
  }
  return res.json({ item });
});

app.get("/api/osm/roads", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  res.json({ items: getOSMRoadSamples(limit) });
});

app.post("/api/osm/route", (req, res) => {
  try {
    const { startPoiKey, endPoiKey, waypointPoiKeys, strategy, mode } = req.body as {
      startPoiKey?: string;
      endPoiKey?: string;
      waypointPoiKeys?: string[];
      strategy?: "shortest-distance" | "shortest-time" | "avoid-crowded";
      mode?: "walk" | "bike" | "shuttle";
    };
    if (!startPoiKey || !endPoiKey) {
      return res.status(400).json({ message: "起点和终点不能为空" });
    }
    const result = planOSMRoute({
      startPoiKey,
      endPoiKey,
      waypointPoiKeys: waypointPoiKeys ?? [],
      strategy: strategy ?? "shortest-distance",
      mode: mode ?? "walk"
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : "路线规划失败" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    return res.status(400).json({ message: "邮箱和密码不能为空" });
  }

  const authUser = verifyPassword(email, password);
  if (!authUser) {
    return res.status(401).json({ message: "邮箱或密码不正确" });
  }

  const token = signToken({ userId: authUser.id, email: authUser.email });
  const state = getAppState();
  return res.json({ token, state: toStateForViewer(state, authUser.id) });
});

app.post("/api/auth/register", (req, res) => {
  const { name, email, password, homeCampus, preferences } = req.body as {
    name?: string;
    email?: string;
    password?: string;
    homeCampus?: string;
    preferences?: PreferenceTag[];
  };

  if (!name || !email || !password || !homeCampus) {
    return res.status(400).json({ message: "请填写完整注册信息" });
  }

  const state = getAppState();
  if (state.users.some((user) => user.email === email)) {
    return res.status(409).json({ message: "该邮箱已注册" });
  }

  const userId = `user-${uuidv4()}`;
  const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0E4B50&color=fff`;
  const nextUser = createPublicUser({
    id: userId,
    name,
    email,
    avatar,
    bio: "把路线、内容和补给都整理成一套完整旅程。",
    joinedAt: new Date().toISOString(),
    homeCampus,
    preferences: preferences ?? []
  });

  createAuthUser(userId, email, password);
  state.users = [nextUser, ...state.users];
  ensureUserCollections(state, userId);
  saveAppState(state);

  const token = signToken({ userId, email });
  return res.status(201).json({ token, state: toStateForViewer(state, userId) });
});

app.post("/api/auth/change-password", (req, res) => {
  const viewer = readViewer(req);
  if (!viewer) {
    return res.status(401).json({ message: "请先登录" });
  }
  const { currentPassword, nextPassword } = req.body as { currentPassword?: string; nextPassword?: string };
  if (!currentPassword || !nextPassword) {
    return res.status(400).json({ message: "请填写当前密码和新密码" });
  }
  const authUser = verifyPassword(viewer.email, currentPassword);
  if (!authUser || authUser.id !== viewer.userId) {
    return res.status(400).json({ message: "当前密码不正确" });
  }
  updateAuthPassword(viewer.userId, nextPassword);
  return res.json({ message: "密码已更新" });
});

app.post("/api/state", (req, res) => {
  const viewer = readViewer(req);
  if (!viewer) {
    return res.status(401).json({ message: "请先登录" });
  }
  const state = req.body.state as PublicAppState | undefined;
  if (!state) {
    return res.status(400).json({ message: "缺少状态数据" });
  }
  ensureUserCollections(state, viewer.userId);
  saveAppState(sanitizeState({ ...state, currentUserId: null }));
  return res.json({ ok: true });
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const viewer = readViewer(req);
  if (!viewer) {
    return res.status(401).json({ message: "请先登录" });
  }
  if (!req.file) {
    return res.status(400).json({ message: "未接收到文件" });
  }
  const kind = (req.query.kind === "video" ? "video" : "image") as "image" | "video";
  const url = await uploadObject(req.file, kind);
  return res.status(201).json({ url });
});

app.use(express.static(distDir));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  const indexPath = path.join(distDir, "index.html");
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return res.status(404).send("JourneyCraft build not found");
});

ensureStorage()
  .catch((error) => {
    console.error("storage init failed", error);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`JourneyCraft server listening on http://0.0.0.0:${port}`);
    });
  });
