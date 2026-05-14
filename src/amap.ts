/// <reference types="vite/client" />

type AMapLike = {
  Map: new (container: HTMLElement, options?: Record<string, unknown>) => any;
  Marker: new (options?: Record<string, unknown>) => any;
  Polyline: new (options?: Record<string, unknown>) => any;
  Pixel: new (x: number, y: number) => any;
};

declare global {
  interface Window {
    AMap?: AMapLike;
    _AMapSecurityConfig?: {
      securityJsCode?: string;
      serviceHost?: string;
    };
    __journeycraftAmapPromise__?: Promise<AMapLike>;
  }
}

const env = import.meta.env as Record<string, string | undefined>;

export function loadAMap(): Promise<AMapLike> {
  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }
  if (window.__journeycraftAmapPromise__) {
    return window.__journeycraftAmapPromise__;
  }

  const key = env.VITE_AMAP_KEY;
  const securityJsCode = env.VITE_AMAP_SECURITY_JS_CODE;
  if (!key || !securityJsCode) {
    return Promise.reject(new Error("缺少高德地图配置，请设置 VITE_AMAP_KEY 和 VITE_AMAP_SECURITY_JS_CODE"));
  }

  window._AMapSecurityConfig = {
    securityJsCode
  };

  window.__journeycraftAmapPromise__ = new Promise<AMapLike>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-amap="journeycraft"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.AMap) {
          resolve(window.AMap);
        }
      });
      existing.addEventListener("error", () => reject(new Error("高德地图脚本加载失败")));
      return;
    }

    const script = document.createElement("script");
    script.dataset.amap = "journeycraft";
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}`;
    script.onload = () => {
      if (!window.AMap) {
        reject(new Error("高德地图对象未初始化"));
        return;
      }
      resolve(window.AMap);
    };
    script.onerror = () => reject(new Error("高德地图脚本加载失败"));
    document.head.appendChild(script);
  });

  return window.__journeycraftAmapPromise__;
}

const xPi = (Math.PI * 3000.0) / 180.0;
const a = 6378245.0;
const ee = 0.00669342162296594323;

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng: number, lat: number) {
  let ret =
    -100.0 +
    2.0 * lng +
    3.0 * lat +
    0.2 * lat * lat +
    0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin((lat / 3.0) * Math.PI)) * 2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((lat / 12.0) * Math.PI) + 320 * Math.sin((lat * Math.PI) / 30.0)) * 2.0) /
    3.0;
  return ret;
}

function transformLon(lng: number, lat: number) {
  let ret =
    300.0 +
    lng +
    2.0 * lat +
    0.1 * lng * lng +
    0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin((lng / 3.0) * Math.PI)) * 2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((lng / 12.0) * Math.PI) + 300.0 * Math.sin((lng / 30.0) * Math.PI)) * 2.0) /
    3.0;
  return ret;
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) {
    return [lng, lat];
  }
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLon = transformLon(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLon, lat + dLat];
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) {
    return [lng, lat];
  }
  const [mgLng, mgLat] = wgs84ToGcj02(lng, lat);
  return [lng * 2 - mgLng, lat * 2 - mgLat];
}

export function bd09ToGcj02(bdLng: number, bdLat: number): [number, number] {
  const x = bdLng - 0.0065;
  const y = bdLat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * xPi);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPi);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}
