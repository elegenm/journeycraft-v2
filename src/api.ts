import type { AppState, OSMImportSummary, OSMNearbyPoi, OSMRouteResult, OSMSelectablePoi, PreferenceTag } from "./types";

const TOKEN_KEY = "journeycraft-auth-token";

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

type ApiOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  isForm?: boolean;
};

async function request<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers();
  if (!options.isForm) {
    headers.set("Content-Type", "application/json");
  }
  if (options.auth) {
    const token = getAuthToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body
      ? options.isForm
        ? (options.body as BodyInit)
        : JSON.stringify(options.body)
      : undefined
  });

  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    throw new Error((data as { message?: string }).message ?? "请求失败");
  }
  return data;
}

export function fetchBootstrap() {
  return request<{ state: AppState }>("/api/bootstrap", { auth: true });
}

export async function login(email: string, password: string) {
  const result = await request<{ token: string; state: AppState }>("/api/auth/login", {
    method: "POST",
    body: { email, password }
  });
  setAuthToken(result.token);
  return result;
}

export async function register(payload: {
  name: string;
  email: string;
  password: string;
  homeCampus: string;
  preferences: PreferenceTag[];
}) {
  const result = await request<{ token: string; state: AppState }>("/api/auth/register", {
    method: "POST",
    body: payload
  });
  setAuthToken(result.token);
  return result;
}

export function changePassword(currentPassword: string, nextPassword: string) {
  return request<{ message: string }>("/api/auth/change-password", {
    method: "POST",
    body: { currentPassword, nextPassword },
    auth: true
  });
}

export function syncState(state: AppState) {
  return request<{ ok: boolean }>("/api/state", {
    method: "POST",
    body: { state: { ...state, currentUserId: null } },
    auth: true
  });
}

export async function uploadFile(file: File, kind: "image" | "video") {
  const formData = new FormData();
  formData.append("file", file);
  const result = await request<{ url: string }>(`/api/upload?kind=${kind}`, {
    method: "POST",
    body: formData,
    auth: true,
    isForm: true
  });
  return result.url;
}

export function fetchOSMSummary() {
  return request<{ import: OSMImportSummary | null }>("/api/osm/summary");
}

export function fetchOSMSelectablePois(limit = 160, query = "") {
  const params = new URLSearchParams({
    limit: String(limit),
    named: "true"
  });
  if (query.trim()) {
    params.set("q", query.trim());
  }
  return request<{ items: OSMSelectablePoi[] }>(`/api/osm/pois?${params.toString()}`);
}

export function planOSMRoute(payload: {
  startPoiKey: string;
  endPoiKey: string;
  waypointPoiKeys: string[];
  strategy: "shortest-distance" | "shortest-time" | "avoid-crowded";
  mode: "walk" | "bike" | "shuttle";
}) {
  return request<OSMRouteResult>("/api/osm/route", {
    method: "POST",
    body: payload
  });
}

export function fetchOSMNearbyPois(params: {
  lat: number;
  lon: number;
  limit?: number;
  query?: string;
  category?: string;
}) {
  const search = new URLSearchParams({
    lat: String(params.lat),
    lon: String(params.lon),
    limit: String(params.limit ?? 20)
  });
  if (params.query?.trim()) {
    search.set("q", params.query.trim());
  }
  if (params.category) {
    search.set("category", params.category);
  }
  return request<{ items: OSMNearbyPoi[] }>(`/api/osm/nearby?${search.toString()}`);
}

export function fetchOSMViewportPois(params: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  limit?: number;
  query?: string;
}) {
  const search = new URLSearchParams({
    minLat: String(params.minLat),
    maxLat: String(params.maxLat),
    minLon: String(params.minLon),
    maxLon: String(params.maxLon),
    limit: String(params.limit ?? 80)
  });
  if (params.query?.trim()) {
    search.set("q", params.query.trim());
  }
  return request<{ items: OSMSelectablePoi[] }>(`/api/osm/viewport-pois?${search.toString()}`);
}
