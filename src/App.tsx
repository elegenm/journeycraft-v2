import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams
} from "react-router-dom";
import {
  billRecords,
  campuses,
  foodItems,
  groupTrips,
  journals as seedJournals,
  preferenceOptions,
  routeAreas,
  scenicSpots,
  users as seedUsers
} from "./data/mockData";
import {
  changePassword as changePasswordRequest,
  fetchBootstrap,
  fetchOSMNearbyPois,
  fetchOSMSelectablePois,
  fetchOSMSummary,
  fetchOSMViewportPois,
  login as loginRequest,
  planOSMRoute as planOSMRouteRequest,
  register as registerRequest,
  setAuthToken,
  syncState,
  uploadFile
} from "./api";
import { gcj02ToWgs84, loadAMap, wgs84ToGcj02 } from "./amap";
import type {
  AppState,
  BillRecord,
  BrowseHistoryEntry,
  Campus,
  FavoriteBucket,
  FavoriteType,
  FoodItem,
  GroupTrip,
  HistoryBucket,
  Journal,
  JournalComment,
  OSMImportSummary,
  OSMNearbyPoi,
  OSMRouteResult,
  OSMSelectablePoi,
  NavigationHistoryEntry,
  PreferenceTag,
  RouteArea,
  RouteEdge,
  RouteNode,
  RouteStrategy,
  SavedRoute,
  SearchHistoryEntry,
  SearchScope,
  TravelMode,
  User,
  VenueHistoryEntry
} from "./types";

const STORAGE_KEY = "journeycraft-app-state";

const defaultFavoriteBucket = (): FavoriteBucket => ({
  scenic: [],
  campus: [],
  food: [],
  journal: [],
  route: []
});

const defaultHistoryBucket = (): HistoryBucket => ({
  browse: [],
  search: [],
  navigation: [],
  venue: []
});

type OSMViewportBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

function initializeState(): AppState {
  const favoritesByUser: Record<string, FavoriteBucket> = {};
  const historyByUser: Record<string, HistoryBucket> = {};
  const savedRoutesByUser: Record<string, SavedRoute[]> = {};
  const billsByUser: Record<string, BillRecord[]> = {};

  seedUsers.forEach((user, index) => {
    favoritesByUser[user.id] = {
      scenic: scenicSpots.slice(index, index + 2).map((item) => item.id),
      campus: [campuses[index % campuses.length].id],
      food: [foodItems[index % foodItems.length].id],
      journal: [seedJournals[index % seedJournals.length].id],
      route: []
    };
    historyByUser[user.id] = defaultHistoryBucket();
    savedRoutesByUser[user.id] = [];
    billsByUser[user.id] = billRecords.slice(index, index + 8);
  });

  return {
    users: seedUsers,
    currentUserId: null,
    favoritesByUser,
    historyByUser,
    savedRoutesByUser,
    billsByUser,
    journals: seedJournals,
    groups: groupTrips
  };
}

function usePersistentState<T>(key: string, initialValue: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        return JSON.parse(raw) as T;
      }
    } catch {
      return typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
    }

    return typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function compactRecord<T>(items: T[], limit = 30): T[] {
  return items.slice(0, limit);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

function scoreByPreference(tags: string[], preferences: string[]): number {
  return tags.reduce((total, tag) => total + (preferences.includes(tag) ? 10 : 0), 0);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function adjacencyFor(area: RouteArea) {
  const map = new Map<string, Array<RouteEdge & { to: string }>>();
  const append = (from: string, to: string, edge: RouteEdge) => {
    const list = map.get(from) ?? [];
    list.push({ ...edge, to });
    map.set(from, list);
  };

  area.edges.forEach((edge) => {
    append(edge.from, edge.to, edge);
    append(edge.to, edge.from, edge);
  });

  return map;
}

function edgeWeight(edge: RouteEdge, strategy: RouteStrategy, mode: TravelMode): number {
  const modeFactor = mode === "walk" ? 1 : mode === "bike" ? 0.72 : 0.64;

  if (!edge.modes.includes(mode)) {
    return Number.POSITIVE_INFINITY;
  }

  if (strategy === "shortest-distance") {
    return edge.distance;
  }

  if (strategy === "shortest-time") {
    return edge.time * modeFactor;
  }

  return edge.time * modeFactor + edge.crowdPenalty * 3;
}

function dijkstra(area: RouteArea, startId: string, endId: string, strategy: RouteStrategy, mode: TravelMode) {
  const adjacency = adjacencyFor(area);
  const distances = new Map<string, number>();
  const previous = new Map<string, string | null>();
  const visited = new Set<string>();
  const queue = new Set(area.nodes.map((node) => node.id));

  area.nodes.forEach((node) => {
    distances.set(node.id, node.id === startId ? 0 : Number.POSITIVE_INFINITY);
    previous.set(node.id, null);
  });

  while (queue.size > 0) {
    let current: string | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;

    queue.forEach((nodeId) => {
      const distance = distances.get(nodeId) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        current = nodeId;
        currentDistance = distance;
      }
    });

    if (!current || current === endId) {
      break;
    }

    queue.delete(current);
    visited.add(current);

    (adjacency.get(current) ?? []).forEach((edge) => {
      if (visited.has(edge.to)) {
        return;
      }

      const weight = edgeWeight(edge, strategy, mode);
      if (!Number.isFinite(weight)) {
        return;
      }

      const candidate = currentDistance + weight;
      if (candidate < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, current);
      }
    });
  }

  const path: string[] = [];
  let current: string | null = endId;

  while (current) {
    path.unshift(current);
    current = previous.get(current) ?? null;
  }

  if (path[0] !== startId) {
    return null;
  }

  let totalDistance = 0;
  let totalTime = 0;
  const adjacencyMap = adjacencyFor(area);
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const edge = (adjacencyMap.get(from) ?? []).find((item) => item.to === to);
    if (edge) {
      totalDistance += edge.distance;
      totalTime += edge.time * (mode === "walk" ? 1 : mode === "bike" ? 0.72 : 0.64);
    }
  }

  return { path, totalDistance, totalTime };
}

function planMultiRoute(
  area: RouteArea,
  startId: string,
  stopIds: string[],
  endId: string,
  strategy: RouteStrategy,
  mode: TravelMode
) {
  const checkpoints = [startId, ...stopIds, endId].filter(Boolean);
  const segments: SavedRoute["segments"] = [];
  let totalDistance = 0;
  let totalTime = 0;

  for (let index = 0; index < checkpoints.length - 1; index += 1) {
    const result = dijkstra(area, checkpoints[index], checkpoints[index + 1], strategy, mode);
    if (!result) {
      return null;
    }
    segments.push({
      from: checkpoints[index],
      to: checkpoints[index + 1],
      nodePath: result.path
    });
    totalDistance += result.totalDistance;
    totalTime += result.totalTime;
  }

  return {
    segments,
    totalDistance: Math.round(totalDistance),
    totalTime: Number(totalTime.toFixed(1))
  };
}

function findNode(area: RouteArea | undefined, nodeId: string) {
  return area?.nodes.find((node) => node.id === nodeId);
}

function polylinePoints(area: RouteArea, nodePath: string[]): string {
  return nodePath
    .map((nodeId) => {
      const node = findNode(area, nodeId);
      return node ? `${node.x},${node.y}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function recommendScenic(preferences: string[]) {
  return [...scenicSpots]
    .sort(
      (left, right) =>
        right.popularity +
        right.rating * 8 +
        scoreByPreference(right.tags, preferences) -
        (left.popularity + left.rating * 8 + scoreByPreference(left.tags, preferences))
    )
    .slice(0, 6);
}

function recommendFood(preferences: string[]) {
  return [...foodItems]
    .sort(
      (left, right) =>
        right.rating * 10 +
        right.popularity +
        scoreByPreference(right.tags, preferences) -
        (left.rating * 10 + left.popularity + scoreByPreference(left.tags, preferences))
    )
    .slice(0, 6);
}

function recommendJournals(preferences: string[]) {
  return [...seedJournals]
    .sort(
      (left, right) =>
        right.likes +
        right.rating * 10 +
        scoreByPreference(right.tags, preferences) -
        (left.likes + left.rating * 10 + scoreByPreference(left.tags, preferences))
    )
    .slice(0, 4);
}

type ActionResult = { ok: boolean; message: string };

type AppActions = {
  login: (email: string, password: string) => Promise<ActionResult>;
  register: (payload: {
    name: string;
    email: string;
    password: string;
    homeCampus: string;
    preferences: PreferenceTag[];
  }) => Promise<ActionResult>;
  logout: () => void;
  updateProfile: (payload: Partial<User>) => void;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<ActionResult>;
  toggleFavorite: (type: FavoriteType, id: string) => void;
  isFavorite: (type: FavoriteType, id: string) => boolean;
  addBrowseHistory: (entry: Omit<BrowseHistoryEntry, "id" | "timestamp">) => void;
  addSearchHistory: (query: string, scope: SearchScope) => void;
  addVenueHistory: (label: string, scope: VenueHistoryEntry["scope"]) => void;
  addNavigationHistory: (entry: Omit<NavigationHistoryEntry, "id" | "timestamp">) => void;
  clearHistoryCategory: (category: keyof HistoryBucket) => void;
  clearAllHistory: () => void;
  saveRoute: (route: SavedRoute) => void;
  createGroup: (payload: { name: string; selectedAreaId: string; memberIds: string[] }) => void;
  submitGroupPreferences: (groupId: string, preferences: PreferenceTag[]) => void;
  createOrUpdateJournal: (payload: Journal) => void;
  deleteJournal: (journalId: string) => void;
  addJournalComment: (journalId: string, content: string) => void;
  toggleJournalLike: (journalId: string) => void;
  rateJournal: (journalId: string, rating: number) => void;
};

function App() {
  const [state, setState] = usePersistentState<AppState>(STORAGE_KEY, initializeState);
  const [bootstrapped, setBootstrapped] = useState(false);
  const navigate = useNavigate();
  const currentUser = state.users.find((user) => user.id === state.currentUserId) ?? null;
  const currentFavorites = currentUser ? state.favoritesByUser[currentUser.id] ?? defaultFavoriteBucket() : defaultFavoriteBucket();
  const currentHistory = currentUser ? state.historyByUser[currentUser.id] ?? defaultHistoryBucket() : defaultHistoryBucket();
  const currentRoutes = currentUser ? state.savedRoutesByUser[currentUser.id] ?? [] : [];
  const currentBills = currentUser ? state.billsByUser[currentUser.id] ?? [] : [];

  useEffect(() => {
    let cancelled = false;
    void fetchBootstrap()
      .then((response) => {
        if (!cancelled) {
          setState(response.state);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setBootstrapped(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setState]);

  useEffect(() => {
    if (!bootstrapped || !currentUser) {
      return;
    }
    const timer = window.setTimeout(() => {
      void syncState(state).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [bootstrapped, currentUser, state]);

  const actions: AppActions = {
    async login(email, password) {
      try {
        const response = await loginRequest(email, password);
        setState(response.state);
        return { ok: true, message: "登录成功" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "登录失败" };
      }
    },
    async register(payload) {
      try {
        const response = await registerRequest(payload);
        setState(response.state);
        return { ok: true, message: "注册成功" };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "注册失败" };
      }
    },
    logout() {
      setAuthToken(null);
      setState((previous) => ({ ...previous, currentUserId: null }));
      navigate("/");
    },
    updateProfile(payload) {
      if (!currentUser) {
        return;
      }
      setState((previous) => ({
        ...previous,
        users: previous.users.map((user) => (user.id === currentUser.id ? { ...user, ...payload } : user))
      }));
    },
    async changePassword(currentPassword, nextPassword) {
      if (!currentUser) {
        return { ok: false, message: "请先登录" };
      }
      try {
        const result = await changePasswordRequest(currentPassword, nextPassword);
        return { ok: true, message: result.message };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "密码更新失败" };
      }
    },
    toggleFavorite(type, id) {
      if (!currentUser) {
        navigate("/auth");
        return;
      }
      setState((previous) => {
        const bucket = previous.favoritesByUser[currentUser.id] ?? defaultFavoriteBucket();
        const hasCurrent = bucket[type].includes(id);
        const nextBucket = {
          ...bucket,
          [type]: hasCurrent ? bucket[type].filter((item) => item !== id) : [id, ...bucket[type]]
        };
        return {
          ...previous,
          favoritesByUser: { ...previous.favoritesByUser, [currentUser.id]: nextBucket }
        };
      });
    },
    isFavorite(type, id) {
      return currentFavorites[type].includes(id);
    },
    addBrowseHistory(entry) {
      if (!currentUser) {
        return;
      }
      setState((previous) => {
        const bucket = previous.historyByUser[currentUser.id] ?? defaultHistoryBucket();
        const nextEntry: BrowseHistoryEntry = {
          id: `${Date.now()}-${entry.targetId}`,
          timestamp: new Date().toISOString(),
          ...entry
        };
        return {
          ...previous,
          historyByUser: {
            ...previous.historyByUser,
            [currentUser.id]: {
              ...bucket,
              browse: compactRecord([nextEntry, ...bucket.browse.filter((item) => item.targetId !== entry.targetId)])
            }
          }
        };
      });
    },
    addSearchHistory(query, scope) {
      if (!currentUser || !query.trim()) {
        return;
      }
      setState((previous) => {
        const bucket = previous.historyByUser[currentUser.id] ?? defaultHistoryBucket();
        const nextEntry: SearchHistoryEntry = {
          id: `${Date.now()}-${scope}`,
          query: query.trim(),
          scope,
          timestamp: new Date().toISOString()
        };
        return {
          ...previous,
          historyByUser: {
            ...previous.historyByUser,
            [currentUser.id]: {
              ...bucket,
              search: compactRecord([
                nextEntry,
                ...bucket.search.filter((item) => !(item.query === nextEntry.query && item.scope === scope))
              ])
            }
          }
        };
      });
    },
    addVenueHistory(label, scope) {
      if (!currentUser) {
        return;
      }
      setState((previous) => {
        const bucket = previous.historyByUser[currentUser.id] ?? defaultHistoryBucket();
        const nextEntry: VenueHistoryEntry = {
          id: `${Date.now()}-${scope}`,
          label,
          scope,
          timestamp: new Date().toISOString()
        };
        return {
          ...previous,
          historyByUser: {
            ...previous.historyByUser,
            [currentUser.id]: {
              ...bucket,
              venue: compactRecord([nextEntry, ...bucket.venue.filter((item) => item.label !== label)])
            }
          }
        };
      });
    },
    addNavigationHistory(entry) {
      if (!currentUser) {
        return;
      }
      setState((previous) => {
        const bucket = previous.historyByUser[currentUser.id] ?? defaultHistoryBucket();
        const nextEntry: NavigationHistoryEntry = {
          id: `${Date.now()}-nav`,
          timestamp: new Date().toISOString(),
          ...entry
        };
        return {
          ...previous,
          historyByUser: {
            ...previous.historyByUser,
            [currentUser.id]: {
              ...bucket,
              navigation: compactRecord([nextEntry, ...bucket.navigation])
            }
          }
        };
      });
    },
    clearHistoryCategory(category) {
      if (!currentUser) {
        return;
      }
      setState((previous) => {
        const bucket = previous.historyByUser[currentUser.id] ?? defaultHistoryBucket();
        return {
          ...previous,
          historyByUser: {
            ...previous.historyByUser,
            [currentUser.id]: { ...bucket, [category]: [] }
          }
        };
      });
    },
    clearAllHistory() {
      if (!currentUser) {
        return;
      }
      setState((previous) => ({
        ...previous,
        historyByUser: {
          ...previous.historyByUser,
          [currentUser.id]: defaultHistoryBucket()
        }
      }));
    },
    saveRoute(route) {
      if (!currentUser) {
        navigate("/auth");
        return;
      }
      setState((previous) => {
        const current = previous.savedRoutesByUser[currentUser.id] ?? [];
        return {
          ...previous,
          savedRoutesByUser: {
            ...previous.savedRoutesByUser,
            [currentUser.id]: compactRecord([route, ...current], 12)
          }
        };
      });
    },
    createGroup(payload) {
      if (!currentUser) {
        navigate("/auth");
        return;
      }
      const memberIds = unique([currentUser.id, ...payload.memberIds]);
      const nextGroup: GroupTrip = {
        id: `group-${Date.now()}`,
        name: payload.name,
        memberIds,
        selectedAreaId: payload.selectedAreaId,
        preferenceVotes: {}
      };
      setState((previous) => ({ ...previous, groups: [nextGroup, ...previous.groups] }));
    },
    submitGroupPreferences(groupId, preferences) {
      if (!currentUser) {
        navigate("/auth");
        return;
      }
      setState((previous) => ({
        ...previous,
        groups: previous.groups.map((group) =>
          group.id === groupId
            ? { ...group, preferenceVotes: { ...group.preferenceVotes, [currentUser.id]: preferences } }
            : group
        )
      }));
    },
    createOrUpdateJournal(payload) {
      setState((previous) => {
        const exists = previous.journals.some((journal) => journal.id === payload.id);
        return {
          ...previous,
          journals: exists
            ? previous.journals.map((journal) => (journal.id === payload.id ? payload : journal))
            : [payload, ...previous.journals]
        };
      });
    },
    deleteJournal(journalId) {
      setState((previous) => ({
        ...previous,
        journals: previous.journals.filter((journal) => journal.id !== journalId)
      }));
    },
    addJournalComment(journalId, content) {
      if (!currentUser || !content.trim()) {
        return;
      }
      setState((previous) => ({
        ...previous,
        journals: previous.journals.map((journal) =>
          journal.id === journalId
            ? {
                ...journal,
                commentCount: journal.commentCount + 1,
                comments: [
                  ...journal.comments,
                  {
                    id: `${journalId}-${Date.now()}`,
                    userId: currentUser.id,
                    content: content.trim(),
                    createdAt: new Date().toISOString()
                  } satisfies JournalComment
                ]
              }
            : journal
        )
      }));
    },
    toggleJournalLike(journalId) {
      setState((previous) => ({
        ...previous,
        journals: previous.journals.map((journal) =>
          journal.id === journalId ? { ...journal, likes: journal.likes + 1 } : journal
        )
      }));
    },
    rateJournal(journalId, rating) {
      setState((previous) => ({
        ...previous,
        journals: previous.journals.map((journal) =>
          journal.id === journalId ? { ...journal, rating: Number(((journal.rating + rating) / 2).toFixed(1)) } : journal
        )
      }));
    }
  };

  return (
    <Layout currentUser={currentUser} onLogout={actions.logout}>
      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              currentUser={currentUser}
              savedRoutes={currentRoutes}
              scenicRecommendations={recommendScenic(currentUser?.preferences ?? preferenceOptions.slice(0, 3))}
              foodRecommendations={recommendFood(currentUser?.preferences ?? preferenceOptions.slice(0, 3))}
              journalRecommendations={state.journals
                .slice()
                .sort((left, right) => right.likes + right.rating - (left.likes + left.rating))
                .slice(0, 4)}
            />
          }
        />
        <Route path="/auth" element={<AuthPage currentUser={currentUser} actions={actions} />} />
        <Route path="/discover" element={<DiscoverPage actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/scenic/:id" element={<ScenicDetailPage actions={actions} currentUser={currentUser} journals={state.journals} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/campuses" element={<CampusListPage actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/campus/:id" element={<CampusDetailPage actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/food" element={<FoodListPage actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/food/:id" element={<FoodDetailPage actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/journals" element={<JournalListPage currentUser={currentUser} journals={state.journals} savedRoutes={currentRoutes} actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/journals/:id" element={<JournalDetailPage currentUser={currentUser} journals={state.journals} users={state.users} actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/navigate" element={<NavigatePage currentUser={currentUser} savedRoutes={currentRoutes} actions={actions} isFavorite={actions.isFavorite} toggleFavorite={actions.toggleFavorite} />} />
        <Route path="/groups" element={<GroupPage currentUser={currentUser} users={state.users} groups={state.groups} actions={actions} />} />
        <Route path="/favorites" element={<FavoritesPage currentUser={currentUser} favorites={currentFavorites} journals={state.journals} savedRoutes={currentRoutes} actions={actions} />} />
        <Route path="/history" element={<HistoryPage currentUser={currentUser} history={currentHistory} actions={actions} />} />
        <Route path="/bills" element={<BillsPage currentUser={currentUser} bills={currentBills} />} />
        <Route path="/profile" element={<ProfilePage currentUser={currentUser} actions={actions} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}

function Layout({ currentUser, onLogout, children }: { currentUser: User | null; onLogout: () => void; children: React.ReactNode }) {
  const location = useLocation();
  const primaryLinks = [
    { to: "/", label: "首页" },
    { to: "/discover", label: "景点" },
    { to: "/campuses", label: "校园" },
    { to: "/food", label: "美食" },
    { to: "/navigate", label: "导航" },
    { to: "/journals", label: "日记" },
    { to: "/groups", label: "协同" }
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark">JC</span>
          <span>
            <strong>JourneyCraft</strong>
            <small>旅游与校园出行平台</small>
          </span>
        </Link>
        <nav className="nav">
          {primaryLinks.map((link) => (
            <NavLink key={link.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} to={link.to}>
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-actions">
          <Link className={`ghost-link${location.pathname === "/favorites" ? " active" : ""}`} to="/favorites">
            收藏
          </Link>
          <Link className={`ghost-link${location.pathname === "/history" ? " active" : ""}`} to="/history">
            历史
          </Link>
          <Link className={`ghost-link${location.pathname === "/bills" ? " active" : ""}`} to="/bills">
            账单
          </Link>
          {currentUser ? (
            <div className="avatar-menu">
              <Link className="avatar-link" to="/profile">
                <img alt={currentUser.name} src={currentUser.avatar} />
                <span>{currentUser.name}</span>
              </Link>
              <button className="secondary-button" onClick={onLogout} type="button">
                退出
              </button>
            </div>
          ) : (
            <Link className="primary-button" to="/auth">
              登录 / 注册
            </Link>
          )}
        </div>
      </header>
      <main className="page-shell">{children}</main>
      <footer className="footer">
        <div>
          <strong>JourneyCraft</strong>
          <p>覆盖发现、导航、美食、协同、日记、收藏、历史与消费复盘的完整出行链路。</p>
        </div>
        <div className="footer-stats">
          <span>景点 120</span>
          <span>校园 90</span>
          <span>路网边 372</span>
          <span>演示用户 12</span>
        </div>
      </footer>
    </div>
  );
}

function HomePage({
  currentUser,
  savedRoutes,
  scenicRecommendations,
  foodRecommendations,
  journalRecommendations
}: {
  currentUser: User | null;
  savedRoutes: SavedRoute[];
  scenicRecommendations: typeof scenicSpots;
  foodRecommendations: typeof foodItems;
  journalRecommendations: Journal[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const routeHighlights = savedRoutes.length > 0 ? savedRoutes.slice(0, 3) : [];

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    navigate(`/discover?query=${encodeURIComponent(query)}`);
  };

  return (
    <div className="stack-xl">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">完整旅程产品</span>
          <h1>把景点发现、校园出行、路径规划和内容记录串成一条真实链路。</h1>
          <p>
            从出行前的推荐和比选，到出行中的路线、设施、美食，再到出行后的日记、收藏、账单与历史回看，JourneyCraft
            用一个统一界面把这件事做完整。
          </p>
          <form className="search-panel" onSubmit={submitSearch}>
            <input
              aria-label="搜索景点或校园"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索景点、校园、美食或日记标题"
              value={query}
            />
            <button className="primary-button" type="submit">
              开始探索
            </button>
          </form>
          <div className="hero-metrics">
            <MetricCard label="可探索目的地" value="210+" />
            <MetricCard label="校园建筑总量" value="1800+" />
            <MetricCard label="导航边数" value="372" />
          </div>
        </div>
        <div className="hero-visual">
          <img alt="JourneyCraft hero" src={scenicRecommendations[0].images[0]} />
          <div className="floating-card">
            <strong>今日推荐</strong>
            <p>{scenicRecommendations[0].name}</p>
            <span>{scenicRecommendations[0].highlight}</span>
          </div>
        </div>
      </section>

      <section className="quick-grid">
        {[
          ["一站发现", "景点、校园、美食和内容统一入口", "/discover"],
          ["路线规划", "多目标、多策略、多交通方式", "/navigate"],
          ["协同出游", "多人偏好折中与最优方案", "/groups"],
          ["旅程日记", "发布、编辑、评论、点赞与评分", "/journals"]
        ].map(([title, description, to]) => (
          <Link className="quick-card" key={title} to={to}>
            <strong>{title}</strong>
            <span>{description}</span>
          </Link>
        ))}
      </section>

      <section className="section-card">
        <SectionHeading title="为你推荐" subtitle={currentUser ? `基于 ${currentUser.name} 的偏好标签自动排序` : "热门榜单与高评分内容"} />
        <div className="card-grid">
          {scenicRecommendations.map((item) => (
            <Link className="content-card scenic" key={item.id} to={`/scenic/${item.id}`}>
              <img alt={item.name} src={item.images[0]} />
              <div className="content-body">
                <h3>{item.name}</h3>
                <p>{item.summary}</p>
                <div className="meta-row">
                  <span>{item.rating} 分</span>
                  <span>热度 {item.popularity}</span>
                  <span>{item.ticket}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="路线亮点" subtitle="保存的路线可直接回看和复用" />
          {routeHighlights.length > 0 ? (
            <div className="stack-md">
              {routeHighlights.map((route) => (
                <div className="inline-card" key={route.id}>
                  <div>
                    <strong>{route.name}</strong>
                    <p>
                      {route.mapName} · {route.mode === "walk" ? "步行" : route.mode === "bike" ? "骑行" : "接驳"} ·{" "}
                      {route.totalDistance} 米 / {route.totalTime} 分钟
                    </p>
                  </div>
                  <Link className="ghost-link" to="/navigate">
                    回看路线
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              action={<Link className="primary-button" to="/navigate">去规划路线</Link>}
              title="还没有保存路线"
              description="先完成一次路线规划，后续可以保存、收藏和再次复用。"
            />
          )}
        </div>
        <div className="section-card">
          <SectionHeading title="热门日记" subtitle="有封面图、图集和互动区的真实内容流" />
          <div className="stack-md">
            {journalRecommendations.map((journal) => (
              <Link className="inline-card journal-card" key={journal.id} to={`/journals/${journal.id}`}>
                <img alt={journal.title} src={journal.cover} />
                <div>
                  <strong>{journal.title}</strong>
                  <p>{journal.excerpt}</p>
                  <span>
                    {journal.likes} 赞 · {journal.commentCount} 评论
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="补给与内容区" subtitle="景点关联美食推荐与高质量内容混排展示" />
        <div className="card-grid food-grid">
          {foodRecommendations.map((item) => (
            <Link className="content-card food" key={item.id} to={`/food/${item.id}`}>
              <img alt={item.name} src={item.images[0]} />
              <div className="content-body">
                <h3>{item.name}</h3>
                <p>{item.summary}</p>
                <div className="meta-row">
                  <span>{item.cuisine}</span>
                  <span>￥{item.price}</span>
                  <span>{item.rating} 分</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <OSMNearbyExplorer
        defaultQuery="地铁"
        subtitle="直接接入昌平真实 OSM POI，并可基于锚点查看周边酒店、站点、餐饮与景观点。"
        title="昌平真实 POI 与周边查询"
      />
    </div>
  );
}

function AuthPage({ currentUser, actions }: { currentUser: User | null; actions: AppActions }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [message, setMessage] = useState("");
  const [loginForm, setLoginForm] = useState({ email: seedUsers[0].email, password: "123456" });
  const [registerForm, setRegisterForm] = useState({
    name: "",
    email: "",
    password: "",
    homeCampus: campuses[0].name,
    preferences: preferenceOptions.slice(0, 2) as PreferenceTag[]
  });

  if (currentUser) {
    return (
      <section className="section-card">
        <SectionHeading title="你已经登录" subtitle={`当前账户：${currentUser.name}`} />
        <div className="inline-actions">
          <Link className="primary-button" to="/profile">
            进入个人中心
          </Link>
          <Link className="secondary-button" to="/">
            回到首页
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-layout">
      <div className="section-card auth-panel">
        <div className="segmented">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">
            登录
          </button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">
            注册
          </button>
        </div>
        {mode === "login" ? (
          <form
            className="stack-md"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await actions.login(loginForm.email, loginForm.password);
              setMessage(result.message);
              if (result.ok) {
                navigate("/");
              }
            }}
          >
            <SectionHeading title="欢迎回来" subtitle="登录后可保存路线、收藏内容、写日记并维护个人资料" />
            <label>
              邮箱
              <input
                onChange={(event) => setLoginForm((previous) => ({ ...previous, email: event.target.value }))}
                value={loginForm.email}
              />
            </label>
            <label>
              密码
              <input
                onChange={(event) => setLoginForm((previous) => ({ ...previous, password: event.target.value }))}
                type="password"
                value={loginForm.password}
              />
            </label>
            <button className="primary-button" type="submit">
              登录
            </button>
            {message ? <p className="form-message">{message}</p> : null}
          </form>
        ) : (
          <form
            className="stack-md"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await actions.register(registerForm);
              setMessage(result.message);
              if (result.ok) {
                navigate("/");
              }
            }}
          >
            <SectionHeading title="创建账户" subtitle="注册后可立即获得个人化推荐和本地持久化数据" />
            <label>
              昵称
              <input
                onChange={(event) => setRegisterForm((previous) => ({ ...previous, name: event.target.value }))}
                required
                value={registerForm.name}
              />
            </label>
            <label>
              邮箱
              <input
                onChange={(event) => setRegisterForm((previous) => ({ ...previous, email: event.target.value }))}
                required
                type="email"
                value={registerForm.email}
              />
            </label>
            <label>
              密码
              <input
                onChange={(event) => setRegisterForm((previous) => ({ ...previous, password: event.target.value }))}
                required
                type="password"
                value={registerForm.password}
              />
            </label>
            <label>
              常驻校园
              <select
                onChange={(event) => setRegisterForm((previous) => ({ ...previous, homeCampus: event.target.value }))}
                value={registerForm.homeCampus}
              >
                {campuses.slice(0, 20).map((campus) => (
                  <option key={campus.id} value={campus.name}>
                    {campus.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="stack-sm">
              <span>偏好标签</span>
              <div className="tag-wall">
                {preferenceOptions.map((tag) => (
                  <button
                    className={registerForm.preferences.includes(tag) ? "tag active" : "tag"}
                    key={tag}
                    onClick={() =>
                      setRegisterForm((previous) => ({
                        ...previous,
                        preferences: previous.preferences.includes(tag)
                          ? previous.preferences.filter((item) => item !== tag)
                          : unique([...previous.preferences, tag]).slice(0, 4)
                      }))
                    }
                    type="button"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <button className="primary-button" type="submit">
              注册并开始使用
            </button>
            {message ? <p className="form-message">{message}</p> : null}
          </form>
        )}
      </div>

      <div className="section-card">
        <SectionHeading title="演示账号" subtitle="可直接使用以下账户体验完整流程" />
        <div className="stack-md">
          {seedUsers.slice(0, 3).map((user) => (
            <button
              className="demo-account"
              key={user.id}
              onClick={() => {
                setMode("login");
                setLoginForm({ email: user.email, password: "123456" });
              }}
              type="button"
            >
              <img alt={user.name} src={user.avatar} />
              <div>
                <strong>{user.name}</strong>
                <span>{user.email}</span>
                <small>密码：123456</small>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function DiscoverPage({
  actions,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get("query") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState<"hot" | "rating" | "name">("hot");

  const filtered = scenicSpots
    .filter((item) => [item.name, item.city, item.tags.join(" "), item.summary].some((text) => text.includes(query)))
    .sort((left, right) => {
      if (sort === "rating") {
        return right.rating - left.rating;
      }
      if (sort === "name") {
        return left.name.localeCompare(right.name);
      }
      return right.popularity - left.popularity;
    });

  return (
    <section className="section-card">
      <SectionHeading title="景点探索" subtitle="支持搜索、排序、收藏与详情跳转" />
      <div className="toolbar">
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称、城市或标签搜索景点"
          value={query}
        />
        <select onChange={(event) => setSort(event.target.value as "hot" | "rating" | "name")} value={sort}>
          <option value="hot">按热度</option>
          <option value="rating">按评分</option>
          <option value="name">按名称</option>
        </select>
        <button
          className="secondary-button"
          onClick={() => {
            setSearchParams(query ? { query } : {});
            actions.addSearchHistory(query, "scenic");
          }}
          type="button"
        >
          记录搜索
        </button>
      </div>
      <div className="card-grid">
        {filtered.slice(0, 24).map((item) => (
          <article className="content-card scenic" key={item.id}>
            <img alt={item.name} src={item.images[0]} />
            <div className="content-body">
              <div className="between-row">
                <h3>{item.name}</h3>
                <FavoriteButton active={isFavorite("scenic", item.id)} onClick={() => toggleFavorite("scenic", item.id)} />
              </div>
              <p>{item.summary}</p>
              <div className="meta-row">
                <span>{item.city}</span>
                <span>{item.rating} 分</span>
                <span>热度 {item.popularity}</span>
              </div>
              <div className="tag-row">
                {item.tags.slice(0, 3).map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              <Link className="text-link" to={`/scenic/${item.id}`}>
                查看详情
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ScenicDetailPage({
  actions,
  currentUser,
  journals,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  currentUser: User | null;
  journals: Journal[];
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const { id } = useParams();
  const scenic = scenicSpots.find((item) => item.id === id);
  const routeArea = routeAreas.find((area) => area.id === scenic?.routeAreaId);
  const relatedFood = foodItems.filter((item) => scenic?.nearbyFoodIds.includes(item.id)).slice(0, 6);
  const relatedJournals = journals.filter((journal) => journal.scenicId === scenic?.id).slice(0, 4);
  const navigate = useNavigate();

  useEffect(() => {
    if (scenic) {
      actions.addBrowseHistory({
        label: scenic.name,
        targetId: scenic.id,
        targetType: "scenic",
        detail: scenic.city
      });
    }
  }, [actions, scenic]);

  if (!scenic || !routeArea) {
    return <NotFoundPage />;
  }

  return (
    <div className="stack-xl">
      <DetailHero
        actions={
          <>
            <FavoriteButton active={isFavorite("scenic", scenic.id)} onClick={() => toggleFavorite("scenic", scenic.id)} />
            <button
              className="primary-button"
              onClick={() => navigate(`/navigate?area=${routeArea.id}&start=${routeArea.pois[0]?.nodeId}&end=${routeArea.pois[3]?.nodeId}`)}
              type="button"
            >
              规划路线
            </button>
          </>
        }
        image={scenic.images[0]}
        subtitle={scenic.summary}
        title={scenic.name}
      >
        <div className="meta-row">
          <span>{scenic.city}</span>
          <span>{scenic.rating} 分</span>
          <span>热度 {scenic.popularity}</span>
          <span>{scenic.openHours}</span>
        </div>
        <div className="tag-row">
          {scenic.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </DetailHero>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="景点信息" subtitle="真实产品化表达，不暴露节点编号和调试字段" />
          <div className="stack-md">
            <p>{scenic.description}</p>
            <p>地址：{scenic.address}</p>
            <p>门票：{scenic.ticket}</p>
            <p>服务链接：<a href={scenic.serviceLink} rel="noreferrer" target="_blank">查看外部服务</a></p>
            <p>路线亮点：{scenic.highlight}</p>
          </div>
        </div>
        <div className="section-card">
          <SectionHeading title="图集" subtitle="详情页包含多张产品图" />
          <div className="gallery-grid">
            {scenic.images.map((image) => (
              <img alt={scenic.name} key={image} src={image} />
            ))}
          </div>
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="导航接入点与拍照建议" subtitle="路线规划基于项目内置路网与算法" />
        <div className="card-grid compact-grid">
          {routeArea.photoSpots.map((spot) => (
            <article className="mini-card" key={spot}>
              <strong>{spot}</strong>
              <p>适合停留拍照并串联最近的补给点。</p>
            </article>
          ))}
          {routeArea.reverseGuide.map((guide) => (
            <article className="mini-card" key={guide}>
              <strong>反向游览建议</strong>
              <p>{guide}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="附近美食" subtitle="从景点详情直接跳转至关联美食" />
        <div className="card-grid food-grid">
          {relatedFood.map((item) => (
            <Link className="content-card food" key={item.id} to={`/food/${item.id}`}>
              <img alt={item.name} src={item.images[0]} />
              <div className="content-body">
                <h3>{item.name}</h3>
                <p>{item.cuisine} · ￥{item.price}</p>
                <div className="meta-row">
                  <span>{item.rating} 分</span>
                  <span>{item.distance} 米</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="关联日记" subtitle={currentUser ? "支持继续评论、点赞和补充个人内容" : "登录后可写日记并参与互动"} />
        <div className="stack-md">
          {relatedJournals.map((journal) => (
            <Link className="inline-card journal-card" key={journal.id} to={`/journals/${journal.id}`}>
              <img alt={journal.title} src={journal.cover} />
              <div>
                <strong>{journal.title}</strong>
                <p>{journal.excerpt}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <OSMNearbyExplorer
        defaultQuery={scenic.city.includes("北京") ? scenic.name : "景点"}
        subtitle="用真实昌平 OSM 数据补充景点周边酒店、站点、商店和景观点查询。"
        title="昌平真实周边查询"
      />
    </div>
  );
}

function CampusListPage({
  actions,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"hot" | "rating">("hot");
  const filtered = campuses
    .filter((campus) => [campus.name, campus.city, campus.summary, campus.tags.join(" ")].some((text) => text.includes(query)))
    .sort((left, right) => (sort === "rating" ? right.rating - left.rating : right.popularity - left.popularity));

  return (
    <section className="section-card">
      <SectionHeading title="校园探索" subtitle="覆盖校园详情、建筑列表、设施说明与关联美食" />
      <div className="toolbar">
        <input onChange={(event) => setQuery(event.target.value)} placeholder="按名称、城市或标签搜索校园" value={query} />
        <select onChange={(event) => setSort(event.target.value as "hot" | "rating")} value={sort}>
          <option value="hot">按热度</option>
          <option value="rating">按评分</option>
        </select>
        <button className="secondary-button" onClick={() => actions.addSearchHistory(query, "campus")} type="button">
          记录搜索
        </button>
      </div>
      <div className="card-grid">
        {filtered.slice(0, 24).map((campus) => (
          <article className="content-card scenic" key={campus.id}>
            <img alt={campus.name} src={campus.images[0]} />
            <div className="content-body">
              <div className="between-row">
                <h3>{campus.name}</h3>
                <FavoriteButton active={isFavorite("campus", campus.id)} onClick={() => toggleFavorite("campus", campus.id)} />
              </div>
              <p>{campus.summary}</p>
              <div className="meta-row">
                <span>{campus.city}</span>
                <span>{campus.rating} 分</span>
                <span>建筑 {campus.buildings.length}</span>
              </div>
              <Link className="text-link" to={`/campus/${campus.id}`}>
                查看校园详情
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CampusDetailPage({
  actions,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const { id } = useParams();
  const campus = campuses.find((item) => item.id === id);
  const routeArea = routeAreas.find((area) => area.id === campus?.routeAreaId);
  const navigate = useNavigate();

  useEffect(() => {
    if (campus) {
      actions.addBrowseHistory({
        label: campus.name,
        targetId: campus.id,
        targetType: "campus",
        detail: campus.city
      });
    }
  }, [actions, campus]);

  if (!campus || !routeArea) {
    return <NotFoundPage />;
  }

  return (
    <div className="stack-xl">
      <DetailHero
        actions={
          <>
            <FavoriteButton active={isFavorite("campus", campus.id)} onClick={() => toggleFavorite("campus", campus.id)} />
            <button
              className="primary-button"
              onClick={() => navigate(`/navigate?area=${routeArea.id}&start=${routeArea.pois[0]?.nodeId}&end=${routeArea.pois[5]?.nodeId}`)}
              type="button"
            >
              校园路线规划
            </button>
          </>
        }
        image={campus.images[0]}
        subtitle={campus.summary}
        title={campus.name}
      >
        <div className="meta-row">
          <span>{campus.city}</span>
          <span>{campus.rating} 分</span>
          <span>设施 {campus.facilities.length}</span>
        </div>
        <div className="tag-row">
          {campus.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </DetailHero>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="校园说明" subtitle="支持楼宇与设施级别的信息表达" />
          <div className="stack-md">
            <p>{campus.description}</p>
            <p>地址：{campus.address}</p>
            <p>开放时间：{campus.openHours}</p>
            <p>外部链接：<a href={campus.serviceLink} rel="noreferrer" target="_blank">查看参考地图</a></p>
          </div>
        </div>
        <div className="section-card">
          <SectionHeading title="校园图集" subtitle="重点区域可直接预览" />
          <div className="gallery-grid">
            {campus.images.map((image) => (
              <img alt={campus.name} key={image} src={image} />
            ))}
          </div>
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="建筑列表 / 详情" subtitle="每栋建筑均提供可读说明、类型与开放时间" />
        <div className="card-grid compact-grid">
          {campus.buildings.slice(0, 12).map((building) => (
            <article className="mini-card" key={building.id}>
              <div className="between-row">
                <strong>{building.name}</strong>
                <button
                  className="ghost-link"
                  onClick={() => actions.addVenueHistory(building.name, "building")}
                  type="button"
                >
                  记入查询
                </button>
              </div>
              <p>{building.description}</p>
              <div className="meta-row">
                <span>{building.category}</span>
                <span>{building.openHours}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="设施列表 / 详情" subtitle="支持服务说明、开放时间和人流强度展示" />
        <div className="card-grid compact-grid">
          {campus.facilities.map((facility) => (
            <article className="mini-card" key={facility.id}>
              <div className="between-row">
                <strong>{facility.name}</strong>
                <button
                  className="ghost-link"
                  onClick={() => actions.addVenueHistory(facility.name, "facility")}
                  type="button"
                >
                  记入查询
                </button>
              </div>
              <p>{facility.description}</p>
              <div className="meta-row">
                <span>{facility.type}</span>
                <span>{facility.openHours}</span>
                <span>拥挤度 {facility.crowd}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="校园周边美食" subtitle="从校园详情直接进入餐饮页" />
        <div className="card-grid food-grid">
          {foodItems
            .filter((item) => campus.recommendedFoodIds.includes(item.id))
            .slice(0, 6)
            .map((item) => (
              <Link className="content-card food" key={item.id} to={`/food/${item.id}`}>
                <img alt={item.name} src={item.images[0]} />
                <div className="content-body">
                  <h3>{item.name}</h3>
                  <p>{item.cuisine}</p>
                  <div className="meta-row">
                    <span>￥{item.price}</span>
                    <span>{item.rating} 分</span>
                  </div>
                </div>
              </Link>
            ))}
        </div>
      </section>

      <OSMNearbyExplorer
        defaultQuery={campus.city.includes("北京") ? campus.name : "大学"}
        subtitle="通过昌平真实 OSM 点位补充校园周边站点、便利设施和生活服务。"
        title="昌平真实校园周边"
      />
    </div>
  );
}

function FoodListPage({
  actions,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"hot" | "rating" | "distance">("hot");
  const [cuisine, setCuisine] = useState("全部");

  const filtered = foodItems
    .filter((item) => [item.name, item.cuisine, item.tags.join(" "), item.summary].some((text) => text.includes(query)))
    .filter((item) => cuisine === "全部" || item.cuisine === cuisine)
    .sort((left, right) => {
      if (sort === "rating") {
        return right.rating - left.rating;
      }
      if (sort === "distance") {
        return left.distance - right.distance;
      }
      return right.popularity - left.popularity;
    });

  return (
    <section className="section-card">
      <SectionHeading title="美食探索" subtitle="支持按热度、评分、距离排序，按菜系筛选" />
      <div className="toolbar">
        <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索餐厅、菜系或标签" value={query} />
        <select onChange={(event) => setCuisine(event.target.value)} value={cuisine}>
          <option value="全部">全部菜系</option>
          {unique(foodItems.map((item) => item.cuisine)).map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select onChange={(event) => setSort(event.target.value as "hot" | "rating" | "distance")} value={sort}>
          <option value="hot">按热度</option>
          <option value="rating">按评分</option>
          <option value="distance">按距离</option>
        </select>
        <button className="secondary-button" onClick={() => actions.addSearchHistory(query, "food")} type="button">
          记录搜索
        </button>
      </div>
      <div className="card-grid food-grid">
        {filtered.slice(0, 24).map((item) => (
          <article className="content-card food" key={item.id}>
            <img alt={item.name} src={item.images[0]} />
            <div className="content-body">
              <div className="between-row">
                <h3>{item.name}</h3>
                <FavoriteButton active={isFavorite("food", item.id)} onClick={() => toggleFavorite("food", item.id)} />
              </div>
              <p>{item.summary}</p>
              <div className="meta-row">
                <span>{item.cuisine}</span>
                <span>￥{item.price}</span>
                <span>{item.distance} 米</span>
              </div>
              <Link className="text-link" to={`/food/${item.id}`}>
                查看详情
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FoodDetailPage({
  actions,
  isFavorite,
  toggleFavorite
}: {
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const { id } = useParams();
  const item = foodItems.find((food) => food.id === id);

  useEffect(() => {
    if (item) {
      actions.addBrowseHistory({
        label: item.name,
        targetId: item.id,
        targetType: "food",
        detail: item.cuisine
      });
      actions.addVenueHistory(item.name, "food");
    }
  }, [actions, item]);

  if (!item) {
    return <NotFoundPage />;
  }

  return (
    <div className="stack-xl">
      <DetailHero
        actions={<FavoriteButton active={isFavorite("food", item.id)} onClick={() => toggleFavorite("food", item.id)} />}
        image={item.images[0]}
        subtitle={item.summary}
        title={item.name}
      >
        <div className="meta-row">
          <span>{item.cuisine}</span>
          <span>￥{item.price}</span>
          <span>{item.rating} 分</span>
          <span>{item.distance} 米</span>
        </div>
      </DetailHero>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="餐饮信息" subtitle="包含菜系、价格、标签、评分与签名菜品" />
          <div className="stack-md">
            <p>{item.summary}</p>
            <p>地址：{item.address}</p>
            <p>招牌：{item.signature}</p>
            <div className="tag-row">
              {item.tags.map((tag) => (
                <span className="tag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
            <a href={item.serviceLink} rel="noreferrer" target="_blank">
              查看外部服务
            </a>
          </div>
        </div>
        <div className="section-card">
          <SectionHeading title="图集" subtitle="用于演示真实餐饮详情页" />
          <div className="gallery-grid">
            {item.images.map((image) => (
              <img alt={item.name} key={image} src={image} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function JournalListPage({
  currentUser,
  journals,
  savedRoutes,
  actions,
  isFavorite,
  toggleFavorite
}: {
  currentUser: User | null;
  journals: Journal[];
  savedRoutes: SavedRoute[];
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const [query, setQuery] = useState("");
  const [editingJournalId, setEditingJournalId] = useState<string | null>(null);
  const [cover, setCover] = useState("");
  const [gallery, setGallery] = useState<string[]>([]);
  const [video, setVideo] = useState("");
  const editingJournal = journals.find((journal) => journal.id === editingJournalId);
  const [form, setForm] = useState({
    scenicId: scenicSpots[0].id,
    title: "",
    content: ""
  });

  useEffect(() => {
    if (editingJournal) {
      setForm({ scenicId: editingJournal.scenicId, title: editingJournal.title, content: editingJournal.content });
      setCover(editingJournal.cover);
      setGallery(editingJournal.gallery);
      setVideo(editingJournal.video ?? "");
    }
  }, [editingJournal]);

  const filtered = journals.filter((journal) => {
    const scenicName = scenicSpots.find((item) => item.id === journal.scenicId)?.name ?? "";
    return [journal.title, journal.content, scenicName].some((text) => text.includes(query));
  });

  async function loadFiles(files: FileList | null, kind: "cover" | "gallery" | "video") {
    if (!files || files.length === 0) {
      return;
    }

    if (kind === "cover") {
      setCover(await uploadFile(files[0], "image"));
      return;
    }

    if (kind === "video") {
      setVideo(await uploadFile(files[0], "video"));
      return;
    }

    const nextGallery = await Promise.all(Array.from(files).slice(0, 4).map((file) => uploadFile(file, "image")));
    setGallery(nextGallery);
  }

  return (
    <div className="stack-xl">
      <section className="section-card">
        <SectionHeading title="旅行日记" subtitle="支持发布、编辑、删除、评论、点赞、评分和按景点/标题检索" />
        <div className="toolbar">
          <input onChange={(event) => setQuery(event.target.value)} placeholder="按标题或景点名称搜索日记" value={query} />
          <button className="secondary-button" onClick={() => actions.addSearchHistory(query, "journal")} type="button">
            记录搜索
          </button>
        </div>
      </section>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title={editingJournal ? "编辑日记" : "发布日记"} subtitle={currentUser ? "支持封面图、图集和视频预览" : "登录后即可发布自己的出行内容"} />
          {currentUser ? (
            <form
              className="stack-md"
              onSubmit={(event) => {
                event.preventDefault();
                const scenic = scenicSpots.find((item) => item.id === form.scenicId);
                if (!scenic) {
                  return;
                }
                const payload: Journal = {
                  id: editingJournal?.id ?? `journal-${Date.now()}`,
                  scenicId: form.scenicId,
                  authorId: currentUser.id,
                  title: form.title,
                  excerpt: form.content.slice(0, 70),
                  content: form.content,
                  cover: cover || gallery[0] || scenic.images[0],
                  gallery: gallery.length > 0 ? gallery : scenic.images,
                  video: video || undefined,
                  tags: scenic.tags.slice(0, 3),
                  likes: editingJournal?.likes ?? 0,
                  rating: editingJournal?.rating ?? 4.5,
                  commentCount: editingJournal?.commentCount ?? 0,
                  createdAt: editingJournal?.createdAt ?? new Date().toISOString(),
                  comments: editingJournal?.comments ?? []
                };
                actions.createOrUpdateJournal(payload);
                setEditingJournalId(null);
                setForm({ scenicId: scenicSpots[0].id, title: "", content: "" });
                setCover("");
                setGallery([]);
                setVideo("");
              }}
            >
              <label>
                关联景点
                <select onChange={(event) => setForm((previous) => ({ ...previous, scenicId: event.target.value }))} value={form.scenicId}>
                  {scenicSpots.slice(0, 20).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                标题
                <input onChange={(event) => setForm((previous) => ({ ...previous, title: event.target.value }))} required value={form.title} />
              </label>
              <label>
                正文
                <textarea onChange={(event) => setForm((previous) => ({ ...previous, content: event.target.value }))} required rows={6} value={form.content} />
              </label>
              <div className="inline-actions">
                <label className="file-field">
                  上传封面
                  <input accept="image/*" onChange={(event) => void loadFiles(event.target.files, "cover")} type="file" />
                </label>
                <label className="file-field">
                  上传图集
                  <input accept="image/*" multiple onChange={(event) => void loadFiles(event.target.files, "gallery")} type="file" />
                </label>
                <label className="file-field">
                  上传视频
                  <input accept="video/*" onChange={(event) => void loadFiles(event.target.files, "video")} type="file" />
                </label>
              </div>
              <div className="inline-actions">
                <button
                  className="secondary-button"
                  onClick={() => {
                    const latestRoute = savedRoutes[0];
                    if (!latestRoute) {
                      return;
                    }
                    setForm((previous) => ({
                      ...previous,
                      title: `${latestRoute.mapName} 路线复盘：${latestRoute.name}`,
                      content: `今天按照 ${latestRoute.name} 走完了 ${latestRoute.mapName} 的完整动线。全程 ${latestRoute.totalDistance} 米，预计 ${latestRoute.totalTime} 分钟，沿途经过 ${latestRoute.highlights.join("、")}。`
                    }));
                  }}
                  type="button"
                >
                  根据最近路线生成
                </button>
                <button className="primary-button" type="submit">
                  {editingJournal ? "保存修改" : "发布日记"}
                </button>
              </div>
              {(cover || gallery.length > 0 || video) && (
                <div className="stack-sm">
                  <span className="muted">媒体预览</span>
                  <div className="gallery-grid">
                    {cover ? <img alt="cover preview" src={cover} /> : null}
                    {gallery.map((image) => (
                      <img alt="gallery preview" key={image} src={image} />
                    ))}
                  </div>
                  {video ? <video controls src={video} /> : null}
                </div>
              )}
            </form>
          ) : (
            <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后才能发布内容" description="你可以先浏览现有日记，登录后再写自己的路线复盘与游记。" />
          )}
        </div>

        <div className="section-card">
          <SectionHeading title="日记列表" subtitle={`共 ${filtered.length} 篇`} />
          <div className="stack-md">
            {filtered.slice(0, 12).map((journal) => {
              const scenic = scenicSpots.find((item) => item.id === journal.scenicId);
              const editable = currentUser?.id === journal.authorId;
              return (
                <article className="inline-card journal-card" key={journal.id}>
                  <img alt={journal.title} src={journal.cover} />
                  <div>
                    <div className="between-row">
                      <Link className="text-link" to={`/journals/${journal.id}`}>
                        {journal.title}
                      </Link>
                      <FavoriteButton active={isFavorite("journal", journal.id)} onClick={() => toggleFavorite("journal", journal.id)} />
                    </div>
                    <p>{journal.excerpt}</p>
                    <div className="meta-row">
                      <span>{scenic?.name}</span>
                      <span>{journal.likes} 赞</span>
                      <span>{journal.commentCount} 评论</span>
                      <span>{journal.rating} 分</span>
                    </div>
                    {editable ? (
                      <div className="inline-actions">
                        <button className="ghost-link" onClick={() => setEditingJournalId(journal.id)} type="button">
                          编辑
                        </button>
                        <button className="ghost-link danger" onClick={() => actions.deleteJournal(journal.id)} type="button">
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function JournalDetailPage({
  currentUser,
  journals,
  users,
  actions,
  isFavorite,
  toggleFavorite
}: {
  currentUser: User | null;
  journals: Journal[];
  users: User[];
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const { id } = useParams();
  const journal = journals.find((item) => item.id === id);
  const scenic = scenicSpots.find((item) => item.id === journal?.scenicId);
  const author = users.find((user) => user.id === journal?.authorId);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (journal) {
      actions.addBrowseHistory({
        label: journal.title,
        targetId: journal.id,
        targetType: "journal",
        detail: scenic?.name ?? "日记"
      });
    }
  }, [actions, journal, scenic?.name]);

  if (!journal || !scenic || !author) {
    return <NotFoundPage />;
  }

  return (
    <div className="stack-xl">
      <DetailHero
        actions={<FavoriteButton active={isFavorite("journal", journal.id)} onClick={() => toggleFavorite("journal", journal.id)} />}
        image={journal.cover}
        subtitle={journal.excerpt}
        title={journal.title}
      >
        <div className="meta-row">
          <span>{author.name}</span>
          <span>{scenic.name}</span>
          <span>{formatDate(journal.createdAt)}</span>
          <span>{journal.rating} 分</span>
        </div>
      </DetailHero>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="正文" subtitle="支持封面图、正文图集与视频内容展示" />
          <div className="stack-md">
            <p>{journal.content}</p>
            <div className="gallery-grid">
              {journal.gallery.map((image) => (
                <img alt={journal.title} key={image} src={image} />
              ))}
            </div>
            {journal.video ? <video controls src={journal.video} /> : null}
          </div>
        </div>
        <div className="section-card">
          <SectionHeading title="互动区" subtitle="评论、点赞和评分完整可用" />
          <div className="inline-actions">
            <button className="secondary-button" onClick={() => actions.toggleJournalLike(journal.id)} type="button">
              点赞 {journal.likes}
            </button>
            {[4, 5].map((score) => (
              <button className="ghost-link" key={score} onClick={() => actions.rateJournal(journal.id, score)} type="button">
                评 {score} 星
              </button>
            ))}
          </div>
          <div className="stack-md">
            {journal.comments.map((entry) => {
              const user = users.find((item) => item.id === entry.userId);
              return (
                <article className="comment-card" key={entry.id}>
                  <strong>{user?.name ?? "匿名用户"}</strong>
                  <p>{entry.content}</p>
                  <span>{formatDate(entry.createdAt)}</span>
                </article>
              );
            })}
          </div>
          {currentUser ? (
            <form
              className="stack-sm"
              onSubmit={(event) => {
                event.preventDefault();
                actions.addJournalComment(journal.id, comment);
                setComment("");
              }}
            >
              <textarea onChange={(event) => setComment(event.target.value)} placeholder="写下你的评论" rows={4} value={comment} />
              <button className="primary-button" type="submit">
                发布评论
              </button>
            </form>
          ) : (
            <p className="muted">登录后可以发表评论。</p>
          )}
        </div>
      </section>
    </div>
  );
}

function NavigatePage({
  currentUser,
  savedRoutes,
  actions,
  isFavorite,
  toggleFavorite
}: {
  currentUser: User | null;
  savedRoutes: SavedRoute[];
  actions: AppActions;
  isFavorite: AppActions["isFavorite"];
  toggleFavorite: AppActions["toggleFavorite"];
}) {
  const [searchParams] = useSearchParams();
  const initialArea = searchParams.get("area") ?? routeAreas[0].id;
  const [dataset, setDataset] = useState<"demo" | "osm">("demo");
  const [areaId, setAreaId] = useState(initialArea);
  const [strategy, setStrategy] = useState<RouteStrategy>("shortest-distance");
  const [mode, setMode] = useState<TravelMode>("walk");
  const area = routeAreas.find((item) => item.id === areaId) ?? routeAreas[0];
  const poiOptions = area.pois;
  const [start, setStart] = useState(searchParams.get("start") ?? poiOptions[0]?.nodeId ?? "");
  const [end, setEnd] = useState(searchParams.get("end") ?? poiOptions[poiOptions.length - 1]?.nodeId ?? "");
  const [waypoints, setWaypoints] = useState<string[]>([]);
  const [route, setRoute] = useState<SavedRoute | null>(null);
  const [osmSummary, setOsmSummary] = useState<OSMImportSummary | null>(null);
  const [osmPois, setOsmPois] = useState<OSMSelectablePoi[]>([]);
  const [osmQuery, setOsmQuery] = useState("");
  const [osmStart, setOsmStart] = useState("");
  const [osmEnd, setOsmEnd] = useState("");
  const [osmWaypoints, setOsmWaypoints] = useState<string[]>([]);
  const [osmRoute, setOsmRoute] = useState<OSMRouteResult | null>(null);
  const [osmVisiblePois, setOsmVisiblePois] = useState<OSMSelectablePoi[]>([]);
  const [osmViewportQuery, setOsmViewportQuery] = useState("");
  const [osmViewportBounds, setOsmViewportBounds] = useState<OSMViewportBounds | null>(null);
  const [mapPickMode, setMapPickMode] = useState<"start" | "end" | "waypoint">("start");
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackRunning, setPlaybackRunning] = useState(false);

  useEffect(() => {
    const nextArea = routeAreas.find((item) => item.id === areaId) ?? routeAreas[0];
    setStart(nextArea.pois[0]?.nodeId ?? "");
    setEnd(nextArea.pois[nextArea.pois.length - 1]?.nodeId ?? "");
    setWaypoints([]);
    setRoute(null);
  }, [areaId]);

  useEffect(() => {
    void fetchOSMSummary()
      .then((response) => {
        if (response.import) {
          setOsmSummary(response.import);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchOSMSelectablePois(160, osmQuery)
      .then((response) => {
        if (!cancelled) {
          setOsmPois(response.items);
          if (!osmStart && response.items[0]) {
            setOsmStart(response.items[0].osmKey);
          }
          if (!osmEnd && response.items[1]) {
            setOsmEnd(response.items[1].osmKey);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [osmQuery, osmStart, osmEnd]);

  useEffect(() => {
    let cancelled = false;
    const bbox = osmViewportBounds ?? osmRoute?.bbox ?? osmSummary?.bbox;
    if (!bbox) {
      return;
    }
    void fetchOSMViewportPois({
      minLat: bbox.minLat,
      maxLat: bbox.maxLat,
      minLon: bbox.minLon,
      maxLon: bbox.maxLon,
      limit: 80,
      query: osmViewportQuery
    }).then((response) => {
      if (!cancelled) {
        setOsmVisiblePois(response.items);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [osmSummary, osmRoute, osmViewportBounds, osmViewportQuery]);

  useEffect(() => {
    if (!playbackRunning || !osmRoute) {
      return;
    }
    const maxIndex = Math.max(osmRoute.polyline.length - 1, 1);
    const timer = window.setInterval(() => {
      setPlaybackIndex((previous) => {
        if (previous >= maxIndex) {
          setPlaybackRunning(false);
          return maxIndex;
        }
        return previous + 1;
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [playbackRunning, osmRoute]);

  const osmPoiCatalog = new Map<string, OSMSelectablePoi>();
  [...osmPois, ...osmVisiblePois, ...(osmRoute?.selectedPois ?? []), ...(osmRoute?.pois ?? [])].forEach((poi) => {
    if (!osmPoiCatalog.has(poi.osmKey)) {
      osmPoiCatalog.set(poi.osmKey, poi);
    }
  });
  const osmStartPoi = osmPoiCatalog.get(osmStart) ?? null;
  const osmEndPoi = osmPoiCatalog.get(osmEnd) ?? null;
  const osmWaypointPoiItems = osmWaypoints
    .map((key) => osmPoiCatalog.get(key) ?? null)
    .filter((item): item is OSMSelectablePoi => item !== null);
  const selectedOsmPois = [osmStartPoi, ...osmWaypointPoiItems, osmEndPoi].filter(
    (item): item is OSMSelectablePoi => item !== null
  );
  const selectedPoiKeys = [osmStart, osmEnd, ...osmWaypoints].filter(Boolean);
  const playbackRatio = osmRoute ? Math.min(playbackIndex / Math.max(osmRoute.polyline.length - 1, 1), 1) : 1;

  const nearbyFacilities = route
    ? area.facilities
        .filter((facility) => {
          const facilityNode = findNode(area, facility.nodeId ?? "");
          const endNode = findNode(area, route.segments.at(-1)?.nodePath.at(-1) ?? "");
          if (!facilityNode || !endNode) {
            return false;
          }
          const deltaX = Math.abs(facilityNode.x - endNode.x);
          const deltaY = Math.abs(facilityNode.y - endNode.y);
          return deltaX + deltaY < 220;
        })
        .slice(0, 4)
    : [];

  const osmNearbyPois =
    osmRoute?.pois.filter((poi) => !osmRoute.selectedPois.some((selected) => selected.osmKey === poi.osmKey)).slice(0, 6) ?? [];

  const handleMapPick = (poi: OSMSelectablePoi) => {
    if (mapPickMode === "start") {
      setOsmStart(poi.osmKey);
      return;
    }
    if (mapPickMode === "end") {
      setOsmEnd(poi.osmKey);
      return;
    }
    setOsmWaypoints((previous) => (previous.includes(poi.osmKey) ? previous : [...previous, poi.osmKey].slice(0, 2)));
  };

  return (
    <div className="stack-xl">
      <section className="section-card">
        <SectionHeading
          title="导航与路线规划"
          subtitle={dataset === "osm" ? "当前已切换为昌平区真实 OSM 路网与 POI 数据" : "路线基于项目自有路网、节点和路径算法生成"}
        />
        <div className="segmented">
          <button className={dataset === "demo" ? "active" : ""} onClick={() => setDataset("demo")} type="button">
            演示路网
          </button>
          <button
            className={dataset === "osm" ? "active" : ""}
            disabled={!osmSummary}
            onClick={() => setDataset("osm")}
            type="button"
          >
            昌平 OSM
          </button>
        </div>
        {dataset === "demo" ? (
          <>
            <div className="planner-grid">
              <label>
                地图区域
                <select onChange={(event) => setAreaId(event.target.value)} value={areaId}>
                  {routeAreas.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                起点
                <select onChange={(event) => setStart(event.target.value)} value={start}>
                  {poiOptions.map((poi) => (
                    <option key={poi.nodeId} value={poi.nodeId}>
                      {poi.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                终点
                <select onChange={(event) => setEnd(event.target.value)} value={end}>
                  {poiOptions.map((poi) => (
                    <option key={poi.nodeId} value={poi.nodeId}>
                      {poi.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                路径策略
                <select onChange={(event) => setStrategy(event.target.value as RouteStrategy)} value={strategy}>
                  <option value="shortest-distance">最短距离</option>
                  <option value="shortest-time">最短时间</option>
                  <option value="avoid-crowded">避开拥挤</option>
                </select>
              </label>
              <label>
                交通方式
                <select onChange={(event) => setMode(event.target.value as TravelMode)} value={mode}>
                  <option value="walk">步行</option>
                  <option value="bike">骑行</option>
                  <option value="shuttle">接驳</option>
                </select>
              </label>
              <div className="waypoint-block">
                <span>中途停靠</span>
                <div className="tag-wall">
                  {poiOptions.slice(1, 8).map((poi) => (
                    <button
                      className={waypoints.includes(poi.nodeId) ? "tag active" : "tag"}
                      key={poi.nodeId}
                      onClick={() =>
                        setWaypoints((previous) =>
                          previous.includes(poi.nodeId)
                            ? previous.filter((item) => item !== poi.nodeId)
                            : [...previous, poi.nodeId].slice(0, 2)
                        )
                      }
                      type="button"
                    >
                      {poi.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="inline-actions">
              <button
                className="primary-button"
                onClick={() => {
                  const planned = planMultiRoute(area, start, waypoints, end, strategy, mode);
                  if (!planned) {
                    return;
                  }

                  const labels = [start, ...waypoints, end].map((nodeId) => findNode(area, nodeId)?.label ?? "节点");
                  const nextRoute: SavedRoute = {
                    id: `route-${Date.now()}`,
                    name: `${area.name} ${labels[0]} - ${labels.at(-1)}`,
                    mapId: area.id,
                    mapName: area.name,
                    waypoints: [start, ...waypoints, end],
                    strategy,
                    mode,
                    segments: planned.segments,
                    totalDistance: planned.totalDistance,
                    totalTime: planned.totalTime,
                    createdAt: new Date().toISOString(),
                    highlights: [area.photoSpots[0], area.reverseGuide[0]]
                  };
                  setRoute(nextRoute);
                  actions.addNavigationHistory({
                    mapName: area.name,
                    startLabel: labels[0],
                    endLabel: labels.at(-1) ?? labels[0],
                    waypointLabels: labels.slice(1, -1),
                    strategy,
                    mode,
                    totalDistance: planned.totalDistance,
                    totalTime: planned.totalTime
                  });
                }}
                type="button"
              >
                生成路线
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  if (!route) {
                    return;
                  }
                  actions.saveRoute(route);
                }}
                type="button"
              >
                保存路线
              </button>
              <span className="muted">
                {currentUser ? "已登录，可保存并收藏路线" : "登录后可保存路线与同步收藏"}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="planner-grid">
              <label>
                地图数据
                <input disabled value={osmSummary?.name ?? "未导入"} />
              </label>
              <label>
                搜索 POI
                <input onChange={(event) => setOsmQuery(event.target.value)} placeholder="搜索昌平酒店、景点、地标、站点" value={osmQuery} />
              </label>
              <PoiAutocompleteField
                label="起点"
                onSelect={(poi) => setOsmStart(poi.osmKey)}
                placeholder="搜索并选择起点"
                selected={osmStartPoi}
              />
              <PoiAutocompleteField
                label="终点"
                onSelect={(poi) => setOsmEnd(poi.osmKey)}
                placeholder="搜索并选择终点"
                selected={osmEndPoi}
              />
              <label>
                路径策略
                <select onChange={(event) => setStrategy(event.target.value as RouteStrategy)} value={strategy}>
                  <option value="shortest-distance">最短距离</option>
                  <option value="shortest-time">最短时间</option>
                  <option value="avoid-crowded">避开主干路</option>
                </select>
              </label>
              <label>
                交通方式
                <select onChange={(event) => setMode(event.target.value as TravelMode)} value={mode}>
                  <option value="walk">步行</option>
                  <option value="bike">骑行</option>
                  <option value="shuttle">接驳</option>
                </select>
              </label>
              <WaypointSearchPicker
                onAdd={(poi) =>
                  setOsmWaypoints((previous) => (previous.includes(poi.osmKey) ? previous : [...previous, poi.osmKey].slice(0, 2)))
                }
                onRemove={(osmKey) => setOsmWaypoints((previous) => previous.filter((item) => item !== osmKey))}
                selected={osmWaypointPoiItems}
              />
            </div>
            <div className="inline-actions">
              <div className="segmented">
                <button className={mapPickMode === "start" ? "active" : ""} onClick={() => setMapPickMode("start")} type="button">
                  点击地图设起点
                </button>
                <button className={mapPickMode === "end" ? "active" : ""} onClick={() => setMapPickMode("end")} type="button">
                  点击地图设终点
                </button>
                <button className={mapPickMode === "waypoint" ? "active" : ""} onClick={() => setMapPickMode("waypoint")} type="button">
                  点击地图加停靠
                </button>
              </div>
              <button
                className="primary-button"
                onClick={async () => {
                  if (!osmStart || !osmEnd) {
                    return;
                  }
                  const planned = await planOSMRouteRequest({
                    startPoiKey: osmStart,
                    endPoiKey: osmEnd,
                    waypointPoiKeys: osmWaypoints,
                    strategy,
                    mode
                  }).catch(() => null);
                  if (!planned) {
                    return;
                  }
                  setOsmRoute(planned);
                  setPlaybackIndex(0);
                  setPlaybackRunning(false);
                  actions.addNavigationHistory({
                    mapName: planned.mapName,
                    startLabel: planned.segments[0]?.fromLabel ?? "起点",
                    endLabel: planned.segments.at(-1)?.toLabel ?? "终点",
                    waypointLabels: planned.segments.slice(0, -1).map((segment) => segment.toLabel),
                    strategy,
                    mode,
                    totalDistance: planned.totalDistance,
                    totalTime: planned.totalTime
                  });
                }}
                type="button"
              >
                生成真实路线
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  if (!osmRoute) {
                    return;
                  }
                  const nextRoute: SavedRoute = {
                    id: `route-${Date.now()}`,
                    name: `${osmRoute.mapName} ${osmRoute.segments[0]?.fromLabel ?? "起点"} - ${osmRoute.segments.at(-1)?.toLabel ?? "终点"}`,
                    mapId: osmSummary?.id ?? "osm",
                    mapName: osmRoute.mapName,
                    waypoints: [osmStart, ...osmWaypoints, osmEnd],
                    strategy,
                    mode,
                    segments: osmRoute.segments.map((segment) => ({
                      from: segment.fromPoiKey,
                      to: segment.toPoiKey,
                      nodePath: segment.nodePath
                    })),
                    totalDistance: osmRoute.totalDistance,
                    totalTime: osmRoute.totalTime,
                    createdAt: new Date().toISOString(),
                    highlights: osmRoute.selectedPois.slice(0, 2).map((poi) => poi.name ?? poi.osmKey)
                  };
                  actions.saveRoute(nextRoute);
                }}
                type="button"
              >
                保存真实路线
              </button>
              {osmSummary ? (
                <span className="muted">
                  昌平范围：{osmSummary.bbox.minLat.toFixed(3)} - {osmSummary.bbox.maxLat.toFixed(3)} / 路网边{" "}
                  {osmSummary.stats.roadEdges}
                </span>
              ) : (
                <span className="muted">尚未检测到已导入的 OSM 数据</span>
              )}
            </div>
          </>
        )}
      </section>

      <section className="split-panel">
        <div className="section-card">
          <SectionHeading
            title={dataset === "osm" ? osmRoute?.mapName ?? osmSummary?.name ?? "昌平 OSM" : area.name}
            subtitle={dataset === "osm" ? "真实道路与路线来自已导入的 OSM 数据" : area.description}
          />
          {dataset === "osm" ? (
            <div className="stack-md">
              <div className="toolbar single-search">
                <input
                  onChange={(event) => setOsmViewportQuery(event.target.value)}
                  placeholder="按当前视口筛选 POI，例如 酒店、地铁、大学、餐饮"
                  value={osmViewportQuery}
                />
              </div>
              <OSMMapView
                onViewportChange={setOsmViewportBounds}
                onPoiPick={handleMapPick}
                playbackRatio={playbackRatio}
                route={osmRoute}
                selectedPoiKeys={selectedPoiKeys}
                selectedPois={selectedOsmPois}
                summary={osmSummary}
                visiblePois={osmVisiblePois}
              />
            </div>
          ) : (
            <MapView area={area} route={route} />
          )}
        </div>
        <div className="section-card">
          <SectionHeading title="路线摘要" subtitle="起点终点与折线首尾保持一致" />
          {dataset === "osm" ? (
            osmRoute ? (
              <div className="stack-md">
                <div className="between-row">
                  <strong>
                    {osmRoute.segments[0]?.fromLabel} - {osmRoute.segments.at(-1)?.toLabel}
                  </strong>
                  <FavoriteButton
                    active={isFavorite("route", `${osmSummary?.id ?? "osm"}:${osmRoute.segments[0]?.fromPoiKey}:${osmRoute.segments.at(-1)?.toPoiKey}`)}
                    onClick={() =>
                      toggleFavorite(
                        "route",
                        `${osmSummary?.id ?? "osm"}:${osmRoute.segments[0]?.fromPoiKey}:${osmRoute.segments.at(-1)?.toPoiKey}`
                      )
                    }
                  />
                </div>
                <div className="meta-row">
                  <span>{osmRoute.totalDistance} 米</span>
                  <span>{osmRoute.totalTime} 分钟</span>
                  <span>{mode === "walk" ? "步行" : mode === "bike" ? "骑行" : "接驳"}</span>
                </div>
                <div className="inline-actions">
                  <button className="secondary-button" onClick={() => setPlaybackRunning((previous) => !previous)} type="button">
                    {playbackRunning ? "暂停回放" : "路线回放"}
                  </button>
                  <button
                    className="ghost-link"
                    onClick={() => {
                      setPlaybackIndex(0);
                      setPlaybackRunning(false);
                    }}
                    type="button"
                  >
                    回到起点
                  </button>
                  <span className="muted">回放进度 {Math.round(playbackRatio * 100)}%</span>
                </div>
                <div className="stack-sm">
                  {osmRoute.segments.map((segment, index) => (
                    <div className="inline-card" key={`${segment.fromPoiKey}-${segment.toPoiKey}`}>
                      <div>
                        <strong>第 {index + 1} 段</strong>
                        <p>
                          {segment.fromLabel} → {segment.toLabel}
                        </p>
                      </div>
                      <span>
                        {segment.distance} 米 / {segment.time} 分钟
                      </span>
                    </div>
                  ))}
                </div>
                <div className="stack-sm">
                  <strong>当前视口 POI</strong>
                  {osmVisiblePois.slice(0, 8).map((poi) => (
                    <button className="inline-card facility-row" key={poi.osmKey} onClick={() => handleMapPick(poi)} type="button">
                      <div>
                        <strong>{poi.name}</strong>
                        <p>
                          {poi.category} · {poi.subtype ?? "未分类"}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="stack-sm">
                  <strong>路线附近点位</strong>
                  {osmNearbyPois.map((poi) => (
                    <div className="inline-card" key={poi.osmKey}>
                      <div>
                        <strong>{poi.name}</strong>
                        <p>
                          {poi.category} · {poi.subtype ?? "未分类"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <EmptyState title="还没有生成真实路线" description="使用搜索选点或点击地图选点后，即可基于真实昌平 OSM 路网生成路径。" />
            )
          ) : route ? (
            <div className="stack-md">
              <div className="between-row">
                <strong>{route.name}</strong>
                <FavoriteButton active={isFavorite("route", route.id)} onClick={() => toggleFavorite("route", route.id)} />
              </div>
              <div className="meta-row">
                <span>{route.totalDistance} 米</span>
                <span>{route.totalTime} 分钟</span>
                <span>{route.strategy === "avoid-crowded" ? "避开拥挤" : route.strategy === "shortest-time" ? "最短时间" : "最短距离"}</span>
              </div>
              <div className="stack-sm">
                {route.segments.map((segment, index) => (
                  <div className="inline-card" key={`${segment.from}-${segment.to}`}>
                    <div>
                      <strong>第 {index + 1} 段</strong>
                      <p>
                        {findNode(area, segment.from)?.label} → {findNode(area, segment.to)?.label}
                      </p>
                    </div>
                    <span>{segment.nodePath.length} 个路口</span>
                  </div>
                ))}
              </div>
              <div className="stack-sm">
                <strong>附近设施查询</strong>
                {nearbyFacilities.map((facility) => (
                  <button
                    className="inline-card facility-row"
                    key={facility.id}
                    onClick={() => actions.addVenueHistory(facility.name, "facility")}
                    type="button"
                  >
                    <div>
                      <strong>{facility.name}</strong>
                      <p>{facility.description}</p>
                    </div>
                    <span>拥挤度 {facility.crowd}</span>
                  </button>
                ))}
              </div>
              <div className="stack-sm">
                <strong>反向游览建议</strong>
                {area.reverseGuide.map((item) => (
                  <p className="muted" key={item}>
                    {item}
                  </p>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState title="还没有生成路线" description="选择起点、终点和中途停靠点后，即可生成可视化折线。" />
          )}
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="已保存路线" subtitle="支持再次查看、收藏和内容复盘" />
        {savedRoutes.length > 0 ? (
          <div className="stack-md">
            {savedRoutes.map((saved) => (
              <div className="inline-card" key={saved.id}>
                <div>
                  <strong>{saved.name}</strong>
                  <p>
                    {saved.mapName} · {saved.totalDistance} 米 / {saved.totalTime} 分钟
                  </p>
                </div>
                <span>{formatDate(saved.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="暂无保存路线" description="完成规划后保存，后续可在这里复用。" />
        )}
      </section>
    </div>
  );
}

function GroupPage({
  currentUser,
  users,
  groups,
  actions
}: {
  currentUser: User | null;
  users: User[];
  groups: GroupTrip[];
  actions: AppActions;
}) {
  const [form, setForm] = useState({
    name: "",
    selectedAreaId: routeAreas[0].id,
    memberIds: [] as string[]
  });
  const [draftPreferences, setDraftPreferences] = useState<PreferenceTag[]>([]);

  return (
    <div className="stack-xl">
      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="创建小组" subtitle="提交成员与区域后即可进入偏好折中流程" />
          {currentUser ? (
            <form
              className="stack-md"
              onSubmit={(event) => {
                event.preventDefault();
                actions.createGroup(form);
                setForm({ name: "", selectedAreaId: routeAreas[0].id, memberIds: [] });
              }}
            >
              <label>
                小组名称
                <input onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))} required value={form.name} />
              </label>
              <label>
                出游区域
                <select onChange={(event) => setForm((previous) => ({ ...previous, selectedAreaId: event.target.value }))} value={form.selectedAreaId}>
                  {routeAreas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="stack-sm">
                <span>邀请成员</span>
                <div className="tag-wall">
                  {users
                    .filter((user) => user.id !== currentUser.id)
                    .slice(0, 8)
                    .map((user) => (
                      <button
                        className={form.memberIds.includes(user.id) ? "tag active" : "tag"}
                        key={user.id}
                        onClick={() =>
                          setForm((previous) => ({
                            ...previous,
                            memberIds: previous.memberIds.includes(user.id)
                              ? previous.memberIds.filter((item) => item !== user.id)
                              : [...previous.memberIds, user.id]
                          }))
                        }
                        type="button"
                      >
                        {user.name}
                      </button>
                    ))}
                </div>
              </div>
              <button className="primary-button" type="submit">
                创建小组
              </button>
            </form>
          ) : (
            <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后可创建小组" description="未登录状态下仍可以浏览现有协同结果页面。" />
          )}
        </div>
        <div className="section-card">
          <SectionHeading title="多人偏好折中逻辑" subtitle="结果页明确展示谁偏好什么、系统如何折中" />
          <div className="stack-sm">
            <p>1. 每位成员提交 2-4 个偏好标签。</p>
            <p>2. 系统按出现频次、景点标签匹配度和热度综合排序。</p>
            <p>3. 输出多人最优方案与备选补给点，保留分歧说明。</p>
          </div>
        </div>
      </section>

      <section className="section-card">
        <SectionHeading title="协同出游结果" subtitle="即使算法继续演进，页面和解释链路保持完整" />
        <div className="stack-md">
          {groups.map((group) => {
            const area = routeAreas.find((entry) => entry.id === group.selectedAreaId);
            const mergedPreferences = Object.values(group.preferenceVotes).flat();
            const counts = preferenceOptions
              .map((tag) => ({ tag, count: mergedPreferences.filter((item) => item === tag).length }))
              .filter((item) => item.count > 0)
              .sort((left, right) => right.count - left.count);
            const recommendations = recommendScenic(counts.map((item) => item.tag));
            return (
              <article className="group-card" key={group.id}>
                <div className="between-row">
                  <div>
                    <h3>{group.name}</h3>
                    <p>{area?.name}</p>
                  </div>
                  <span>{group.memberIds.length} 人</span>
                </div>
                <div className="stack-sm">
                  {group.memberIds.map((memberId) => {
                    const member = users.find((user) => user.id === memberId);
                    const votes = group.preferenceVotes[memberId] ?? [];
                    return (
                      <div className="inline-card" key={memberId}>
                        <strong>{member?.name}</strong>
                        <p>{votes.length > 0 ? votes.join(" / ") : "暂未提交偏好"}</p>
                      </div>
                    );
                  })}
                </div>
                <div className="tag-row">
                  {counts.map((item) => (
                    <span className="tag active" key={item.tag}>
                      {item.tag} × {item.count}
                    </span>
                  ))}
                </div>
                <div className="inline-card">
                  <div>
                    <strong>系统折中结果</strong>
                    <p>
                      优先兼顾 {counts.slice(0, 2).map((item) => item.tag).join("、")}，推荐
                      {recommendations[0]?.name} 与 {recommendations[1]?.name} 作为主行程。
                    </p>
                  </div>
                </div>
                {currentUser && group.memberIds.includes(currentUser.id) ? (
                  <div className="stack-sm">
                    <span>提交我的偏好</span>
                    <div className="tag-wall">
                      {preferenceOptions.map((tag) => (
                        <button
                          className={draftPreferences.includes(tag) ? "tag active" : "tag"}
                          key={tag}
                          onClick={() =>
                            setDraftPreferences((previous) =>
                              previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag].slice(0, 4)
                            )
                          }
                          type="button"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    <button className="secondary-button" onClick={() => actions.submitGroupPreferences(group.id, draftPreferences)} type="button">
                      提交偏好
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function FavoritesPage({
  currentUser,
  favorites,
  journals,
  savedRoutes,
  actions
}: {
  currentUser: User | null;
  favorites: FavoriteBucket;
  journals: Journal[];
  savedRoutes: SavedRoute[];
  actions: AppActions;
}) {
  const [type, setType] = useState<FavoriteType>("scenic");

  if (!currentUser) {
    return <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后查看个人收藏" description="收藏景点、校园、美食、日记和路线后，会按类型集中展示。" />;
  }

  const dataMap = {
    scenic: scenicSpots.filter((item) => favorites.scenic.includes(item.id)).map((item) => ({ id: item.id, title: item.name, meta: item.city })),
    campus: campuses.filter((item) => favorites.campus.includes(item.id)).map((item) => ({ id: item.id, title: item.name, meta: item.city })),
    food: foodItems.filter((item) => favorites.food.includes(item.id)).map((item) => ({ id: item.id, title: item.name, meta: item.cuisine })),
    journal: journals
      .filter((item) => favorites.journal.includes(item.id))
      .map((item) => ({ id: item.id, title: item.title, meta: formatDate(item.createdAt) })),
    route: savedRoutes.filter((item) => favorites.route.includes(item.id)).map((item) => ({ id: item.id, title: item.name, meta: `${item.totalDistance} 米` }))
  };

  return (
    <section className="section-card">
      <SectionHeading title="我的收藏" subtitle="收藏状态即时可见，并按类型切换查看" />
      <div className="segmented">
        {(["scenic", "campus", "food", "journal", "route"] as FavoriteType[]).map((item) => (
          <button className={type === item ? "active" : ""} key={item} onClick={() => setType(item)} type="button">
            {item === "scenic" ? "景点" : item === "campus" ? "校园" : item === "food" ? "美食" : item === "journal" ? "日记" : "路线"}
          </button>
        ))}
      </div>
      <div className="stack-md">
        {dataMap[type].length > 0 ? (
          dataMap[type].map((item) => (
            <div className="inline-card" key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.meta}</p>
              </div>
              <button className="ghost-link danger" onClick={() => actions.toggleFavorite(type, item.id)} type="button">
                取消收藏
              </button>
            </div>
          ))
        ) : (
          <EmptyState title="当前分类还没有收藏" description="在列表页或详情页点击收藏后，会立即出现在这里。" />
        )}
      </div>
    </section>
  );
}

function HistoryPage({
  currentUser,
  history,
  actions
}: {
  currentUser: User | null;
  history: HistoryBucket;
  actions: AppActions;
}) {
  const [tab, setTab] = useState<keyof HistoryBucket>("browse");

  if (!currentUser) {
    return <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后查看历史记录" description="浏览、搜索、导航与场所查询会按分类沉淀，支持局部清空和全部清空。" />;
  }

  const entries = history[tab];
  const describeEntry = (entry: (typeof entries)[number]) => {
    if ("detail" in entry) {
      return entry.detail;
    }
    if ("query" in entry) {
      return entry.scope;
    }
    if ("startLabel" in entry) {
      return `${entry.startLabel} → ${entry.endLabel}`;
    }
    return entry.scope;
  };

  const titleEntry = (entry: (typeof entries)[number]) => {
    if ("label" in entry) {
      return entry.label;
    }
    if ("query" in entry) {
      return entry.query;
    }
    return entry.mapName;
  };

  return (
    <section className="section-card">
      <SectionHeading title="历史记录" subtitle="支持分类切换、清空当前分类和清空全部" />
      <div className="segmented">
        {[
          ["browse", "浏览历史"],
          ["search", "搜索历史"],
          ["navigation", "导航历史"],
          ["venue", "场所查询"]
        ].map(([key, label]) => (
          <button className={tab === key ? "active" : ""} key={key} onClick={() => setTab(key as keyof HistoryBucket)} type="button">
            {label}
          </button>
        ))}
      </div>
      <div className="inline-actions">
        <button className="secondary-button" onClick={() => actions.clearHistoryCategory(tab)} type="button">
          清空当前分类
        </button>
        <button className="ghost-link danger" onClick={() => actions.clearAllHistory()} type="button">
          清空全部
        </button>
      </div>
      <div className="stack-md">
        {entries.length > 0 ? (
          entries.map((entry) => (
            <div className="inline-card" key={entry.id}>
              <div>
                <strong>{titleEntry(entry)}</strong>
                <p>{describeEntry(entry)}</p>
              </div>
              <span>{formatDate(entry.timestamp)}</span>
            </div>
          ))
        ) : (
          <EmptyState title="这一类历史还是空的" description="开始浏览、搜索或规划路线后，记录会自动出现在这里。" />
        )}
      </div>
    </section>
  );
}

function BillsPage({ currentUser, bills }: { currentUser: User | null; bills: BillRecord[] }) {
  if (!currentUser) {
    return <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后查看消费账单" description="系统会按交通、住宿、餐饮、购物和门票分类统计，支持旅行复盘。" />;
  }

  const total = bills.reduce((sum, item) => sum + item.amount, 0);
  const categories = ["交通", "住宿", "餐饮", "购物", "门票"] as BillRecord["category"][];

  return (
    <section className="section-card">
      <SectionHeading title="旅行账单" subtitle="即使没有真实支付接入，也能完整演示分类账单与统计" />
      <div className="hero-metrics">
        <MetricCard label="总支出" value={`￥${total}`} />
        <MetricCard label="记录数" value={`${bills.length}`} />
        <MetricCard label="覆盖城市" value={`${unique(bills.map((item) => item.city)).length}`} />
      </div>
      <div className="stats-grid">
        {categories.map((category) => (
          <article className="mini-card" key={category}>
            <strong>{category}</strong>
            <p>￥{bills.filter((item) => item.category === category).reduce((sum, item) => sum + item.amount, 0)}</p>
          </article>
        ))}
      </div>
      <div className="stack-md">
        {bills.map((bill) => (
          <div className="inline-card" key={bill.id}>
            <div>
              <strong>{bill.title}</strong>
              <p>
                {bill.category} · {bill.city} · {bill.note}
              </p>
            </div>
            <span>
              ￥{bill.amount} · {bill.date}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProfilePage({ currentUser, actions }: { currentUser: User | null; actions: AppActions }) {
  const [message, setMessage] = useState("");
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", nextPassword: "" });

  if (!currentUser) {
    return <EmptyState action={<Link className="primary-button" to="/auth">去登录</Link>} title="登录后管理资料" description="个人中心支持头像上传、资料编辑、偏好设置和密码修改。" />;
  }

  return (
    <div className="stack-xl">
      <section className="split-panel">
        <div className="section-card">
          <SectionHeading title="个人资料" subtitle="顶部头像、个人页头像与编辑结果实时一致" />
          <div className="profile-header">
            <img alt={currentUser.name} className="profile-avatar" src={currentUser.avatar} />
            <div>
              <h2>{currentUser.name}</h2>
              <p>{currentUser.email}</p>
              <span>{currentUser.homeCampus}</span>
            </div>
          </div>
          <div className="stack-md">
            <label className="file-field">
              上传头像
              <input
                accept="image/*"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) {
                    return;
                  }
                  actions.updateProfile({ avatar: await uploadFile(file, "image") });
                }}
                type="file"
              />
            </label>
            <label>
              昵称
              <input onChange={(event) => actions.updateProfile({ name: event.target.value })} value={currentUser.name} />
            </label>
            <label>
              个人简介
              <textarea onChange={(event) => actions.updateProfile({ bio: event.target.value })} rows={4} value={currentUser.bio} />
            </label>
            <label>
              常驻校园
              <input onChange={(event) => actions.updateProfile({ homeCampus: event.target.value })} value={currentUser.homeCampus} />
            </label>
            <div className="stack-sm">
              <span>偏好设置</span>
              <div className="tag-wall">
                {preferenceOptions.map((tag) => (
                  <button
                    className={currentUser.preferences.includes(tag) ? "tag active" : "tag"}
                    key={tag}
                    onClick={() =>
                      actions.updateProfile({
                        preferences: currentUser.preferences.includes(tag)
                          ? currentUser.preferences.filter((item) => item !== tag)
                          : [...currentUser.preferences, tag].slice(0, 5)
                      })
                    }
                    type="button"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="section-card">
          <SectionHeading title="密码修改" subtitle="登录态持久化的同时支持本地账户密码更新" />
          <form
            className="stack-md"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await actions.changePassword(passwordForm.currentPassword, passwordForm.nextPassword);
              setMessage(result.message);
              if (result.ok) {
                setPasswordForm({ currentPassword: "", nextPassword: "" });
              }
            }}
          >
            <label>
              当前密码
              <input
                onChange={(event) => setPasswordForm((previous) => ({ ...previous, currentPassword: event.target.value }))}
                type="password"
                value={passwordForm.currentPassword}
              />
            </label>
            <label>
              新密码
              <input
                onChange={(event) => setPasswordForm((previous) => ({ ...previous, nextPassword: event.target.value }))}
                type="password"
                value={passwordForm.nextPassword}
              />
            </label>
            <button className="primary-button" type="submit">
              更新密码
            </button>
            {message ? <p className="form-message">{message}</p> : null}
          </form>
        </div>
      </section>
    </div>
  );
}

function NotFoundPage() {
  return <EmptyState action={<Link className="primary-button" to="/">返回首页</Link>} title="页面不存在" description="目标页面可能已移除，或当前链接无效。" />;
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function OSMNearbyExplorer({
  title,
  subtitle,
  defaultQuery
}: {
  title: string;
  subtitle: string;
  defaultQuery: string;
}) {
  const [query, setQuery] = useState(defaultQuery);
  const [matches, setMatches] = useState<OSMSelectablePoi[]>([]);
  const [anchor, setAnchor] = useState<OSMSelectablePoi | null>(null);
  const [nearby, setNearby] = useState<OSMNearbyPoi[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchOSMSelectablePois(8, query).then((response) => {
      if (cancelled) {
        return;
      }
      setMatches(response.items);
      setAnchor((previous) => {
        if (previous && response.items.some((item) => item.osmKey === previous.osmKey)) {
          return previous;
        }
        return response.items[0] ?? null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    if (!anchor) {
      setNearby([]);
      return;
    }
    void fetchOSMNearbyPois({ lat: anchor.lat, lon: anchor.lon, limit: 6 }).then((response) => {
      if (!cancelled) {
        setNearby(response.items.filter((item) => item.osmKey !== anchor.osmKey));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  return (
    <section className="section-card">
      <SectionHeading title={title} subtitle={subtitle} />
      <div className="toolbar single-search">
        <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索昌平真实 POI，例如 地铁、酒店、景点、大学" value={query} />
      </div>
      <div className="split-panel">
        <div className="stack-md">
          <strong>匹配结果</strong>
          {matches.length > 0 ? (
            matches.map((item) => (
              <button
                className={anchor?.osmKey === item.osmKey ? "inline-card selection-card active-card" : "inline-card selection-card"}
                key={item.osmKey}
                onClick={() => setAnchor(item)}
                type="button"
              >
                <div>
                  <strong>{item.name}</strong>
                  <p>
                    {item.category} · {item.subtype ?? "未分类"}
                  </p>
                </div>
              </button>
            ))
          ) : (
            <p className="muted">没有匹配到可展示的真实 POI。</p>
          )}
        </div>
        <div className="stack-md">
          <strong>周边推荐</strong>
          {anchor ? (
            <>
              <div className="inline-card">
                <div>
                  <strong>{anchor.name}</strong>
                  <p>
                    锚点位置 · {anchor.category} / {anchor.subtype ?? "未分类"}
                  </p>
                </div>
              </div>
              {nearby.map((item) => (
                <div className="inline-card" key={item.osmKey}>
                  <div>
                    <strong>{item.name}</strong>
                    <p>
                      {item.category} · {item.subtype ?? "未分类"}
                    </p>
                  </div>
                  <span>{item.distance} 米</span>
                </div>
              ))}
            </>
          ) : (
            <p className="muted">先从左侧选择一个真实 POI 锚点。</p>
          )}
        </div>
      </div>
    </section>
  );
}

function PoiAutocompleteField({
  label,
  placeholder,
  selected,
  onSelect
}: {
  label: string;
  placeholder: string;
  selected: OSMSelectablePoi | null;
  onSelect: (poi: OSMSelectablePoi) => void;
}) {
  const [query, setQuery] = useState(selected?.name ?? "");
  const [suggestions, setSuggestions] = useState<OSMSelectablePoi[]>([]);

  useEffect(() => {
    setQuery(selected?.name ? `${selected.name}` : "");
  }, [selected?.osmKey, selected?.name]);

  useEffect(() => {
    let cancelled = false;
    void fetchOSMSelectablePois(8, query).then((response) => {
      if (!cancelled) {
        setSuggestions(response.items);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <label className="search-picker">
      {label}
      <input onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} value={query} />
      <div className="picker-list">
        {suggestions.map((item) => (
          <button
            className={selected?.osmKey === item.osmKey ? "picker-item active-card" : "picker-item"}
            key={item.osmKey}
            onClick={() => onSelect(item)}
            type="button"
          >
            <strong>{item.name}</strong>
            <span>
              {item.category} · {item.subtype ?? "未分类"}
            </span>
          </button>
        ))}
      </div>
    </label>
  );
}

function WaypointSearchPicker({
  selected,
  onAdd,
  onRemove
}: {
  selected: OSMSelectablePoi[];
  onAdd: (poi: OSMSelectablePoi) => void;
  onRemove: (osmKey: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<OSMSelectablePoi[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchOSMSelectablePois(8, query).then((response) => {
      if (!cancelled) {
        setSuggestions(response.items.filter((item) => !selected.some((entry) => entry.osmKey === item.osmKey)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [query, selected]);

  return (
    <div className="waypoint-block">
      <span>中途停靠</span>
      <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索并添加中途停靠点" value={query} />
      <div className="picker-list">
        {suggestions.map((item) => (
          <button className="picker-item" key={item.osmKey} onClick={() => onAdd(item)} type="button">
            <strong>{item.name}</strong>
            <span>
              {item.category} · {item.subtype ?? "未分类"}
            </span>
          </button>
        ))}
      </div>
      <div className="tag-wall">
        {selected.map((item) => (
          <button className="tag active" key={item.osmKey} onClick={() => onRemove(item.osmKey)} type="button">
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="section-card empty-state">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </section>
  );
}

function FavoriteButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button aria-label="toggle favorite" className={active ? "favorite-button active" : "favorite-button"} onClick={onClick} type="button">
      {active ? "已收藏" : "收藏"}
    </button>
  );
}

function DetailHero({
  title,
  subtitle,
  image,
  actions,
  children
}: {
  title: string;
  subtitle: string;
  image: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="detail-hero">
      <img alt={title} src={image} />
      <div className="detail-copy">
        <span className="eyebrow">详情页</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        {children}
        {actions ? <div className="inline-actions">{actions}</div> : null}
      </div>
    </section>
  );
}

function MapView({ area, route }: { area: RouteArea; route: SavedRoute | null }) {
  return (
    <div className="map-panel">
      <svg viewBox="0 0 760 460">
        {area.edges.map((edge, index) => {
          const from = findNode(area, edge.from);
          const to = findNode(area, edge.to);
          if (!from || !to) {
            return null;
          }
          return <line className="map-edge" key={`${edge.from}-${edge.to}-${index}`} x1={from.x} x2={to.x} y1={from.y} y2={to.y} />;
        })}
        {route?.segments.map((segment, index) => (
          <polyline className="map-route" key={`${segment.from}-${segment.to}-${index}`} points={polylinePoints(area, segment.nodePath)} />
        ))}
        {area.nodes.map((node) => (
          <g key={node.id}>
            <circle className={node.kind === "junction" ? "map-node junction" : "map-node"} cx={node.x} cy={node.y} r={node.kind === "junction" ? 6 : 9} />
            {node.kind !== "junction" ? <text x={node.x + 12} y={node.y - 12}>{node.label}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

function OSMMapView({
  route,
  summary,
  visiblePois,
  selectedPoiKeys,
  selectedPois,
  playbackRatio,
  onPoiPick,
  onViewportChange
}: {
  route: OSMRouteResult | null;
  summary: OSMImportSummary | null;
  visiblePois: OSMSelectablePoi[];
  selectedPoiKeys: string[];
  selectedPois: OSMSelectablePoi[];
  playbackRatio: number;
  onPoiPick: (poi: OSMSelectablePoi) => void;
  onViewportChange: (bbox: OSMViewportBounds) => void;
}) {
  const bbox = route?.bbox ?? summary?.bbox;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const overlayRef = useRef<any[]>([]);
  const readyRef = useRef(false);
  const visiblePoisRef = useRef(visiblePois);
  const onPoiPickRef = useRef(onPoiPick);
  const onViewportChangeRef = useRef(onViewportChange);
  const lastRouteSignatureRef = useRef<string | null>(null);
  const summaryCenteredRef = useRef(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    visiblePoisRef.current = visiblePois;
  }, [visiblePois]);

  useEffect(() => {
    onPoiPickRef.current = onPoiPick;
  }, [onPoiPick]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const readPoint = (point: any) => {
    if (!point) {
      return null;
    }
    const lng = typeof point.getLng === "function" ? point.getLng() : point.lng;
    const lat = typeof point.getLat === "function" ? point.getLat() : point.lat;
    if (typeof lng !== "number" || typeof lat !== "number") {
      return null;
    }
    return { lng, lat };
  };

  useEffect(() => {
    let cancelled = false;
    if (!bbox || mapRef.current) {
      return;
    }

    void loadAMap()
      .then((AMap) => {
        if (cancelled || !containerRef.current || !bbox || mapRef.current) {
          return;
        }

        amapRef.current = AMap;
        const [centerLon, centerLat] = wgs84ToGcj02((bbox.minLon + bbox.maxLon) / 2, (bbox.minLat + bbox.maxLat) / 2);
        const map = new AMap.Map(containerRef.current, {
          viewMode: "2D",
          resizeEnable: true,
          zoom: 10.8,
          center: [centerLon, centerLat],
          mapStyle: "amap://styles/normal"
        });

        const syncViewport = () => {
          const bounds = map.getBounds?.();
          const southWest = readPoint(bounds?.getSouthWest?.());
          const northEast = readPoint(bounds?.getNorthEast?.());
          if (!southWest || !northEast) {
            return;
          }
          const [swLon, swLat] = gcj02ToWgs84(southWest.lng, southWest.lat);
          const [neLon, neLat] = gcj02ToWgs84(northEast.lng, northEast.lat);
          onViewportChangeRef.current({
            minLat: Math.min(swLat, neLat),
            maxLat: Math.max(swLat, neLat),
            minLon: Math.min(swLon, neLon),
            maxLon: Math.max(swLon, neLon)
          });
        };

        map.on?.("moveend", syncViewport);
        map.on?.("zoomend", syncViewport);
        map.on?.("click", (event: any) => {
          const point = readPoint(event?.lnglat);
          if (!point || visiblePoisRef.current.length === 0) {
            return;
          }
          const [lon, lat] = gcj02ToWgs84(point.lng, point.lat);
          const nearest = visiblePoisRef.current
            .map((poi) => ({
              poi,
              distance: Math.abs(poi.lon - lon) + Math.abs(poi.lat - lat)
            }))
            .sort((left, right) => left.distance - right.distance)[0];
          if (nearest) {
            onPoiPickRef.current(nearest.poi);
          }
        });

        mapRef.current = map;
        readyRef.current = true;
        summaryCenteredRef.current = false;
        setMapError(null);
        window.setTimeout(syncViewport, 180);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setMapError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bbox]);

  useEffect(() => {
    return () => {
      readyRef.current = false;
      overlayRef.current = [];
      lastRouteSignatureRef.current = null;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || !readyRef.current) {
      return;
    }

    if (overlayRef.current.length > 0) {
      map.remove?.(overlayRef.current);
    }

    const overlays: any[] = [];
    const visiblePolyline =
      route?.polyline.length && route.polyline.length > 1
        ? route.polyline.slice(0, Math.max(2, Math.floor((route.polyline.length - 1) * playbackRatio) + 1))
        : [];

    if (route?.polyline.length && route.polyline.length > 1) {
      const fullPath = route.polyline.map(([lon, lat]) => {
        const [nextLon, nextLat] = wgs84ToGcj02(lon, lat);
        return [nextLon, nextLat];
      });
      overlays.push(
        new AMap.Polyline({
          path: fullPath,
          strokeColor: "rgba(14, 75, 80, 0.28)",
          strokeWeight: 8,
          strokeOpacity: 1,
          lineJoin: "round",
          lineCap: "round"
        })
      );

      if (visiblePolyline.length > 1) {
        const playbackPath = visiblePolyline.map(([lon, lat]) => {
          const [nextLon, nextLat] = wgs84ToGcj02(lon, lat);
          return [nextLon, nextLat];
        });
        overlays.push(
          new AMap.Polyline({
            path: playbackPath,
            strokeColor: "#d06a2f",
            strokeWeight: 10,
            strokeOpacity: 1,
            lineJoin: "round",
            lineCap: "round"
          })
        );

        const tip = playbackPath.at(-1);
        if (tip) {
          overlays.push(
            new AMap.Marker({
              position: tip,
              offset: new AMap.Pixel(-10, -10),
              content: '<div class="amap-playback-marker"></div>'
            })
          );
        }
      }
    }

    visiblePois
      .filter((poi) => !selectedPoiKeys.includes(poi.osmKey))
      .slice(0, 120)
      .forEach((poi) => {
        const [lon, lat] = wgs84ToGcj02(poi.lon, poi.lat);
        const marker = new AMap.Marker({
          position: [lon, lat],
          offset: new AMap.Pixel(-6, -6),
          title: poi.name ?? poi.osmKey,
          content: '<div class="amap-poi-marker"></div>'
        });
        marker.on?.("click", () => onPoiPickRef.current(poi));
        overlays.push(marker);
      });

    selectedPois.forEach((poi, index) => {
      const [lon, lat] = wgs84ToGcj02(poi.lon, poi.lat);
      const role = index === 0 ? "start" : index === selectedPois.length - 1 ? "end" : "waypoint";
      const label = escapeHtml(poi.name ?? poi.osmKey);
      const marker = new AMap.Marker({
        position: [lon, lat],
        offset: new AMap.Pixel(-14, -40),
        title: poi.name ?? poi.osmKey,
        content: `<div class="amap-selected-marker ${role}"><span>${label}</span></div>`
      });
      marker.on?.("click", () => onPoiPickRef.current(poi));
      overlays.push(marker);
    });

    map.add?.(overlays);
    overlayRef.current = overlays;
  }, [playbackRatio, route, selectedPoiKeys, selectedPois, visiblePois]);

  useEffect(() => {
    const map = mapRef.current;
    const routeSignature = route ? route.segments.map((segment) => `${segment.fromPoiKey}:${segment.toPoiKey}`).join("|") : null;
    if (!map || !bbox) {
      return;
    }
    if (routeSignature && routeSignature !== lastRouteSignatureRef.current) {
      lastRouteSignatureRef.current = routeSignature;
      if (overlayRef.current.length > 0) {
        map.setFitView?.(overlayRef.current, false, [72, 72, 72, 72]);
      }
      return;
    }
    if (!routeSignature && !summaryCenteredRef.current) {
      const [centerLon, centerLat] = wgs84ToGcj02((bbox.minLon + bbox.maxLon) / 2, (bbox.minLat + bbox.maxLat) / 2);
      map.setZoomAndCenter?.(10.8, [centerLon, centerLat]);
      summaryCenteredRef.current = true;
    }
  }, [bbox, route]);

  if (mapError) {
    return <div className="map-panel muted">{mapError}</div>;
  }

  if (!bbox) {
    return <div className="map-panel muted">还没有可显示的 OSM 地图数据。</div>;
  }

  return (
    <div className="map-panel amap-panel">
      <div className="amap-canvas" ref={containerRef} />
      <div className="amap-status">
        <span>高德底图渲染</span>
        <span>{route ? `后端路线 ${Math.round(route.totalDistance)}m` : "拖动或缩放地图可刷新当前视口 POI"}</span>
      </div>
    </div>
  );
}

export default App;
