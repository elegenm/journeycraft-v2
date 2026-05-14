import { v4 as uuidv4 } from "uuid";
import {
  billRecords,
  campuses,
  foodItems,
  groupTrips,
  journals as seedJournals,
  scenicSpots,
  users as seedUsers
} from "../src/data/mockData.js";
import type {
  AppState,
  BillRecord,
  FavoriteBucket,
  GroupTrip,
  HistoryBucket,
  Journal,
  SavedRoute,
  User
} from "../src/types.js";

export type PublicUser = Omit<User, "password">;
export type PublicAppState = Omit<AppState, "users"> & { users: PublicUser[] };

export function createFavoriteBucket(): FavoriteBucket {
  return {
    scenic: [],
    campus: [],
    food: [],
    journal: [],
    route: []
  };
}

export function createHistoryBucket(): HistoryBucket {
  return {
    browse: [],
    search: [],
    navigation: [],
    venue: []
  };
}

export function sanitizeUsers(users: User[]): PublicUser[] {
  return users.map(({ password: _password, ...user }) => user);
}

export function createSeedState(): PublicAppState {
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
    historyByUser[user.id] = createHistoryBucket();
    savedRoutesByUser[user.id] = [];
    billsByUser[user.id] = billRecords.slice(index, index + 8);
  });

  return {
    users: sanitizeUsers(seedUsers),
    currentUserId: null,
    favoritesByUser,
    historyByUser,
    savedRoutesByUser,
    billsByUser,
    journals: seedJournals,
    groups: groupTrips
  };
}

export function ensureUserCollections(state: PublicAppState, userId: string) {
  if (!state.favoritesByUser[userId]) {
    state.favoritesByUser[userId] = createFavoriteBucket();
  }
  if (!state.historyByUser[userId]) {
    state.historyByUser[userId] = createHistoryBucket();
  }
  if (!state.savedRoutesByUser[userId]) {
    state.savedRoutesByUser[userId] = [];
  }
  if (!state.billsByUser[userId]) {
    state.billsByUser[userId] = billRecords.slice(0, 6);
  }
}

export function createPublicUser(payload: {
  id: string;
  name: string;
  email: string;
  avatar: string;
  bio: string;
  joinedAt: string;
  homeCampus: string;
  preferences: User["preferences"];
}): PublicUser {
  return { ...payload };
}

export function sanitizeState(state: AppState | PublicAppState): PublicAppState {
  return {
    ...state,
    users: state.users.map((user) => {
      if ("password" in user) {
        const { password: _password, ...publicUser } = user;
        return publicUser;
      }
      return user;
    }),
    currentUserId: state.currentUserId ?? null
  };
}

export function createJournalId(): string {
  return `journal-${uuidv4()}`;
}
