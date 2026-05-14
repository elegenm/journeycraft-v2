export type PreferenceTag =
  | "自然风光"
  | "人文建筑"
  | "拍照出片"
  | "夜游氛围"
  | "亲子友好"
  | "校园漫步"
  | "咖啡甜品"
  | "本地风味"
  | "安静学习"
  | "轻运动";

export type FavoriteType = "scenic" | "campus" | "food" | "journal" | "route";
export type SearchScope = "scenic" | "campus" | "food" | "journal";
export type RouteStrategy = "shortest-distance" | "shortest-time" | "avoid-crowded";
export type TravelMode = "walk" | "bike" | "shuttle";

export interface User {
  id: string;
  name: string;
  email: string;
  password?: string;
  avatar: string;
  bio: string;
  joinedAt: string;
  homeCampus: string;
  preferences: PreferenceTag[];
}

export interface ScenicSpot {
  id: string;
  name: string;
  city: string;
  address: string;
  summary: string;
  description: string;
  tags: string[];
  rating: number;
  popularity: number;
  openHours: string;
  ticket: string;
  serviceLink: string;
  images: string[];
  routeAreaId: string;
  nearbyFoodIds: string[];
  highlight: string;
}

export interface Building {
  id: string;
  name: string;
  category: string;
  description: string;
  openHours: string;
  tags: string[];
}

export interface Facility {
  id: string;
  name: string;
  type: string;
  description: string;
  openHours: string;
  crowd: number;
  tags: string[];
  nodeId?: string;
}

export interface Campus {
  id: string;
  name: string;
  city: string;
  address: string;
  summary: string;
  description: string;
  tags: string[];
  rating: number;
  popularity: number;
  openHours: string;
  ticket: string;
  serviceLink: string;
  images: string[];
  routeAreaId: string;
  buildings: Building[];
  facilities: Facility[];
  recommendedFoodIds: string[];
}

export interface FoodItem {
  id: string;
  name: string;
  cuisine: string;
  price: number;
  distance: number;
  rating: number;
  popularity: number;
  tags: string[];
  address: string;
  summary: string;
  signature: string;
  images: string[];
  serviceLink: string;
  scenicId?: string;
  campusId?: string;
}

export interface JournalComment {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface Journal {
  id: string;
  scenicId: string;
  authorId: string;
  title: string;
  excerpt: string;
  content: string;
  cover: string;
  gallery: string[];
  video?: string;
  tags: string[];
  likes: number;
  rating: number;
  commentCount: number;
  createdAt: string;
  comments: JournalComment[];
}

export interface RouteNode {
  id: string;
  x: number;
  y: number;
  label: string;
  kind: "gate" | "landmark" | "food" | "building" | "facility" | "junction";
}

export interface RouteEdge {
  from: string;
  to: string;
  distance: number;
  time: number;
  crowdPenalty: number;
  modes: TravelMode[];
}

export interface RoutePoi {
  id: string;
  name: string;
  nodeId: string;
  category: "gate" | "landmark" | "food" | "building" | "facility";
}

export interface RouteArea {
  id: string;
  name: string;
  areaType: "scenic" | "campus";
  description: string;
  heroImage: string;
  nodes: RouteNode[];
  edges: RouteEdge[];
  pois: RoutePoi[];
  facilities: Facility[];
  photoSpots: string[];
  reverseGuide: string[];
}

export interface PlannedRouteSegment {
  from: string;
  to: string;
  nodePath: string[];
}

export interface SavedRoute {
  id: string;
  name: string;
  mapId: string;
  mapName: string;
  waypoints: string[];
  strategy: RouteStrategy;
  mode: TravelMode;
  segments: PlannedRouteSegment[];
  totalDistance: number;
  totalTime: number;
  createdAt: string;
  highlights: string[];
}

export interface GroupTrip {
  id: string;
  name: string;
  memberIds: string[];
  selectedAreaId: string;
  preferenceVotes: Record<string, PreferenceTag[]>;
}

export interface BillRecord {
  id: string;
  title: string;
  category: "交通" | "住宿" | "餐饮" | "购物" | "门票";
  amount: number;
  date: string;
  note: string;
  city: string;
}

export interface BrowseHistoryEntry {
  id: string;
  label: string;
  targetId: string;
  targetType: "scenic" | "campus" | "food" | "journal";
  detail: string;
  timestamp: string;
}

export interface SearchHistoryEntry {
  id: string;
  query: string;
  scope: SearchScope;
  timestamp: string;
}

export interface NavigationHistoryEntry {
  id: string;
  mapName: string;
  startLabel: string;
  endLabel: string;
  waypointLabels: string[];
  strategy: RouteStrategy;
  mode: TravelMode;
  totalDistance: number;
  totalTime: number;
  timestamp: string;
}

export interface VenueHistoryEntry {
  id: string;
  label: string;
  scope: "facility" | "food" | "building";
  timestamp: string;
}

export interface FavoriteBucket {
  scenic: string[];
  campus: string[];
  food: string[];
  journal: string[];
  route: string[];
}

export interface HistoryBucket {
  browse: BrowseHistoryEntry[];
  search: SearchHistoryEntry[];
  navigation: NavigationHistoryEntry[];
  venue: VenueHistoryEntry[];
}

export interface AppState {
  users: User[];
  currentUserId: string | null;
  favoritesByUser: Record<string, FavoriteBucket>;
  historyByUser: Record<string, HistoryBucket>;
  savedRoutesByUser: Record<string, SavedRoute[]>;
  billsByUser: Record<string, BillRecord[]>;
  journals: Journal[];
  groups: GroupTrip[];
}

export interface OSMImportSummary {
  id: string;
  name: string;
  bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
  stats: Record<string, number>;
}

export interface OSMSelectablePoi {
  osmKey: string;
  name: string | null;
  category: string;
  subtype: string | null;
  lat: number;
  lon: number;
}

export interface OSMNearbyPoi extends OSMSelectablePoi {
  distance: number;
}

export interface OSMRouteSegment {
  fromPoiKey: string;
  toPoiKey: string;
  fromLabel: string;
  toLabel: string;
  nodePath: string[];
  coordinates: [number, number][];
  distance: number;
  time: number;
}

export interface OSMRouteRoad {
  id: number;
  name: string | null;
  highway: string;
  geometry: [number, number][];
}

export interface OSMRouteResult {
  mapName: string;
  bbox: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  };
  totalDistance: number;
  totalTime: number;
  polyline: [number, number][];
  segments: OSMRouteSegment[];
  roads: OSMRouteRoad[];
  pois: OSMSelectablePoi[];
  selectedPois: OSMSelectablePoi[];
}
